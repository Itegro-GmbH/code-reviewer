// SPDX-License-Identifier: LicenseRef-Proprietary

// The service behind the profile routes (#843): validate a profile without storing it, and list, read, create, save new versions of and
// archive the profiles of ONE workspace. Who may call is the route's (`withWorkspace`); every rule about the data is here. A body is
// checked by the pure validator, then against the world: the model must be one the claim would run (the same rule as the Implementer
// form, `ImplementerModels.check`) and the cost limit within the operator's maximum per turn. A profile that does not pass is refused
// with the same list of errors the validate call gives. The version a person saves is stored as typed values; every save is a new
// version, the name of a profile never changes, and a stored version is history: it is not checked again when the world changes (the
// start of a task checks the model and the cost limit again, because that is when they matter).
import type {
  ProfilesRepository,
  StoredProfile,
  StoredProfileVersion,
} from "../db/repositories/profiles-repository.ts";
import type { ImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import type { ImplementerModels } from "../implementer/models.ts";
import {
  CLAUDE_CODE_HARNESS,
  OPENCODE_HARNESS,
} from "../runner-identity/harness.ts";
import { issue, listNames, shown } from "../workflows/issues.ts";
import type { ResultSchema } from "../workflows/result-schema.ts";
import { ProfileError, type ProfileIssue } from "./errors.ts";
import {
  ARCHIVED_PROFILES_PER_WORKSPACE_MAX,
  PROFILE_ID_MAX_LENGTH,
  PROFILES_PER_WORKSPACE_MAX,
  VERSIONS_PER_PROFILE_MAX,
} from "./limits.ts";
import {
  validateProfile,
  type ProfileDocument,
  type ProfileCheck,
} from "./validate.ts";

export type ProfileSummaryView = {
  id: string;
  name: string;
  /** The current version. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** When the profile was archived: not listed, takes no new version, never started. `null` while it is not. */
  archivedAt: string | null;
};

export type ProfileList = {
  profiles: ProfileSummaryView[];
  /** How many profiles the workspace may hold. */
  maximum: number;
};

export type ProfileVersionInfo = { version: number; savedAt: string };

export type ProfileView = ProfileSummaryView & {
  /** The version the `document` is: the current one unless an older was asked for. */
  documentVersion: number;
  /** What that version says, in the shape of the body that made it, every optional field filled in. */
  document: ProfileDocument;
  /**
   * #919: the version names an environment that is no longer one of the workspace (removed since). Its `document.environment` is null
   * then, as for a version saved before profiles had one, and this tells the two apart.
   */
  environmentGone: boolean;
  /** Every saved version, the newest first. */
  versions: ProfileVersionInfo[];
};

export type ProfileValidation = {
  valid: boolean;
  errors: ProfileIssue[];
  truncated: boolean;
};

export type ProfileService = {
  /** Checks a body against the format, the models and the operator's maximum. Stores nothing. */
  validate(body: unknown): Promise<ProfileValidation>;
  list(): Promise<ProfileList>;
  /** The profile with its current version, or with the version asked for. */
  get(id: string, version?: number): Promise<ProfileView>;
  create(user: { id: string }, body: unknown): Promise<ProfileView>;
  /** Saves `body` as the next version. `expectedVersion`: only if that is still the current one. The name must be the profile's. */
  update(
    user: { id: string },
    id: string,
    body: unknown,
    expectedVersion?: number,
  ): Promise<ProfileView>;
  /**
   * Archives a profile: it leaves the list and the count of the workspace, takes no new version and is not started; its name is free
   * again and its versions stay readable. Asked again, it answers the same.
   */
  archive(id: string): Promise<ProfileView>;
};

export type ProfileServiceDependencies = {
  profiles: ProfilesRepository;
  /** The rule of the Implementer form for a model, as the claim applies it. */
  models: Pick<ImplementerModels, "check">;
  /** #919: the environments of the workspace: the one a profile runs in is named by its name and stored by its id. */
  environments: Pick<ImplementerEnvironmentsRepository, "listSummaries">;
  /** The operator's maximum cost per turn in whole US cents, read for each call. */
  operatorCostLimitCents(): Promise<number>;
  /** The most profiles a workspace may hold: `PROFILES_PER_WORKSPACE_MAX`. */
  profilesMax?: number;
  /** The most archived profiles a workspace may hold: `ARCHIVED_PROFILES_PER_WORKSPACE_MAX`. */
  archivedMax?: number;
};

function summaryOf(profile: StoredProfile): ProfileSummaryView {
  return {
    id: profile.id,
    name: profile.name,
    version: profile.version,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    archivedAt: profile.archivedAt,
  };
}

/** What a stored version says as a document: the typed values, the schema parsed from the text that was validated. */
export function documentOf(
  name: string,
  version: StoredProfileVersion,
  /** The name of the environment the version runs in; null when it names none or the environment is gone. */
  environment: string | null = null,
): ProfileDocument {
  const { content } = version;
  return {
    name,
    description: content.description,
    model: content.model,
    instructions: content.instructions,
    // #918: `costLimitCents` is deprecated and ignored by a workflow; a stored version may still hold one, and it is not shown.
    canPush: content.canPush,
    defaultResult:
      content.defaultResult === null
        ? null
        : (JSON.parse(content.defaultResult) as ResultSchema),
    harness: content.harness ?? OPENCODE_HARNESS,
    environment,
  };
}

export function createProfileService({
  profiles,
  models,
  environments,
  operatorCostLimitCents,
  profilesMax = PROFILES_PER_WORKSPACE_MAX,
  archivedMax = ARCHIVED_PROFILES_PER_WORKSPACE_MAX,
}: ProfileServiceDependencies): ProfileService {
  /** The validator's verdict, with what only the world knows added once the body has the right shape. */
  async function check(body: unknown): Promise<
    Omit<ProfileCheck, "errors"> & {
      errors: ProfileIssue[];
      /** The id of the environment the valid body names. */
      environmentId?: string;
    }
  > {
    const shape = validateProfile(body);
    const errors: ProfileIssue[] = [...shape.errors];
    if (shape.profile === undefined) return { ...shape, errors };
    const { model, costLimitCents = null } = shape.profile;
    if (costLimitCents !== null) {
      const maximum = await operatorCostLimitCents();
      if (costLimitCents > maximum)
        errors.push({
          path: "/costLimitCents",
          code: "cost_limit_above_maximum",
          message: `The cost limit is above the maximum of ${maximum} US cents per turn this deployment allows. Use ${maximum} or less.`,
        });
    }
    // #856: the model of the harness claude-code is a name Claude Code reads, run on the login of a runner's device: no catalog, no
    // enablement, no key of the workspace stands behind it, so there is nothing to check here.
    const reason =
      shape.profile.harness === CLAUDE_CODE_HARNESS
        ? null
        : await models.check(model);
    if (reason !== null)
      errors.push({
        path: "/model",
        code: "model_not_allowed",
        message: `This workspace cannot run that model (reason: ${reason}). GET /api/w/<workspace>/implementer/models lists the models it can.`,
      });
    const environment = await findEnvironment(shape.profile.environment);
    if (environment.kind === "unknown")
      errors.push(
        issue(
          "/environment",
          "environment_unknown",
          `There is no environment ${shown(shape.profile.environment ?? "")} in this workspace. Environments: ${listNames(environment.names)}.`,
          environment.names,
        ),
      );
    else {
      // #854, #919: a runner works with its owner's own key, and a harness other than OpenCode exists only on a runner.
      if (environment.kind === "runner" && "entryId" in model)
        errors.push(
          issue(
            "/environment",
            "runner_needs_own_key",
            `The environment ${shown(environment.name)} runs on a runner, which works with the workspace's own key, but the model is a managed one (an entry of the catalog). Choose a model of your own key, or an environment of the platform.`,
          ),
        );
      if (
        environment.kind === "hosted" &&
        shape.profile.harness !== OPENCODE_HARNESS
      )
        errors.push(
          issue(
            "/environment",
            "harness_needs_runner",
            `The harness ${shown(shape.profile.harness)} exists only on a runner, and the environment ${shown(environment.name)} is one of the platform. Choose an environment that runs on a runner.`,
          ),
        );
    }
    if (errors.length === shape.errors.length && environment.kind !== "unknown")
      return { ...shape, errors, environmentId: environment.id };
    return { valid: false, errors, truncated: shape.truncated };
  }

  /** The environment a body names, by name (case ignored), or the names that exist. */
  async function findEnvironment(
    name: string | null,
  ): Promise<
    | { kind: "hosted" | "runner"; id: string; name: string }
    | { kind: "unknown"; names: string[] }
  > {
    const known = await environments.listSummaries();
    const found = known.find(
      (candidate) =>
        candidate.name.toLowerCase() === (name ?? "").toLowerCase(),
    );
    return found === undefined
      ? { kind: "unknown", names: known.map((e) => e.name) }
      : { kind: found.kind, id: found.id, name: found.name };
  }

  async function viewOf(
    profile: StoredProfile,
    shown: StoredProfileVersion,
  ): Promise<ProfileView> {
    const versions = await profiles.listVersions(profile.id);
    const environmentId = shown.content.environmentId ?? null;
    const environment =
      environmentId === null
        ? null
        : ((await environments.listSummaries()).find(
            (candidate) => candidate.id === environmentId,
          )?.name ?? null);
    return {
      ...summaryOf(profile),
      documentVersion: shown.version,
      document: documentOf(profile.name, shown, environment),
      environmentGone: environmentId !== null && environment === null,
      versions: versions.map((v) => ({
        version: v.version,
        savedAt: v.createdAt,
      })),
    };
  }

  /** The checked profile with the id of its environment, or the refusal with every problem. */
  async function acceptable(
    body: unknown,
  ): Promise<{ profile: ProfileDocument; environmentId: string }> {
    const result = await check(body);
    if (
      !result.valid ||
      result.profile === undefined ||
      result.environmentId === undefined
    )
      throw new ProfileError(
        "PROFILE_INVALID",
        "The profile does not pass the validator.",
        { errors: result.errors, truncated: result.truncated },
      );
    return { profile: result.profile, environmentId: result.environmentId };
  }

  const notFound = (): ProfileError =>
    new ProfileError("PROFILE_NOT_FOUND", "There is no such profile.");

  function checkId(id: string): void {
    if (id.length === 0 || id.length > PROFILE_ID_MAX_LENGTH) throw notFound();
  }

  const contentOf = (profile: ProfileDocument, environmentId: string) => ({
    description: profile.description,
    model: profile.model,
    instructions: profile.instructions,
    costLimitCents: profile.costLimitCents ?? null,
    canPush: profile.canPush,
    defaultResult:
      profile.defaultResult === null
        ? null
        : JSON.stringify(profile.defaultResult),
    harness: profile.harness,
    environmentId,
  });

  return {
    async validate(body) {
      const result = await check(body);
      return {
        valid: result.valid,
        errors: result.errors,
        truncated: result.truncated,
      };
    },

    async list() {
      return {
        profiles: (await profiles.list()).map(summaryOf),
        maximum: profilesMax,
      };
    },

    async get(id, version) {
      checkId(id);
      const found = await profiles.get(id);
      if (found === undefined) throw notFound();
      if (version === undefined || version === found.current.version)
        return viewOf(found.profile, found.current);
      const older = await profiles.getVersion(id, version);
      if (older === undefined)
        throw new ProfileError(
          "PROFILE_VERSION_NOT_FOUND",
          "The profile has no such version.",
        );
      return viewOf(found.profile, older);
    },

    async create(user, body) {
      const { profile, environmentId } = await acceptable(body);
      const created = await profiles.create(
        {
          name: profile.name,
          content: contentOf(profile, environmentId),
          createdBy: user.id,
        },
        profilesMax,
      );
      if (!created.ok) {
        if (created.reason === "name_taken")
          throw new ProfileError(
            "PROFILE_NAME_TAKEN",
            "The workspace has a profile of that name.",
          );
        throw new ProfileError(
          "PROFILE_LIMIT_REACHED",
          "The workspace holds the most profiles it may.",
          { maximum: profilesMax },
        );
      }
      return viewOf(created.profile, created.saved);
    },

    async archive(id) {
      checkId(id);
      const archived = await profiles.archive(id, archivedMax);
      if (!archived.ok) {
        if (archived.reason === "limit_reached")
          throw new ProfileError(
            "PROFILE_ARCHIVE_LIMIT_REACHED",
            "The workspace holds the most archived profiles it may.",
            { maximum: archivedMax },
          );
        throw notFound();
      }
      const found = await profiles.get(id);
      if (found === undefined) throw notFound();
      return viewOf(found.profile, found.current);
    },

    async update(user, id, body, expectedVersion) {
      checkId(id);
      // An id that is not there is not found whatever the body says.
      const existing = await profiles.get(id);
      if (existing === undefined) throw notFound();
      // An archived profile takes no new version, whatever the body says.
      if (existing.profile.archivedAt !== null)
        throw new ProfileError(
          "PROFILE_ARCHIVED",
          "The profile is archived and takes no new version.",
        );
      const { profile, environmentId } = await acceptable(body);
      if (existing.profile.name !== profile.name)
        throw new ProfileError(
          "PROFILE_NAME_CHANGED",
          "The name of a profile never changes. Create a new profile for another name.",
          {
            errors: [
              issue(
                "/name",
                "invalid_value",
                `The profile is called ${existing.profile.name}, and a workflow refers to it by that name, so a new version keeps it. Use "name": "${existing.profile.name}", or create a new profile for another name.`,
              ),
            ],
          },
        );
      const saved = await profiles.saveVersion(
        id,
        {
          content: contentOf(profile, environmentId),
          createdBy: user.id,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        },
        VERSIONS_PER_PROFILE_MAX,
      );
      if (saved.ok) return viewOf(saved.profile, saved.saved);
      switch (saved.reason) {
        case "not_found":
          throw notFound();
        case "archived":
          throw new ProfileError(
            "PROFILE_ARCHIVED",
            "The profile is archived and takes no new version.",
          );
        case "version_conflict":
          throw new ProfileError(
            "PROFILE_VERSION_CONFLICT",
            "The profile was saved since that version.",
            { current: saved.current },
          );
        case "version_limit_reached":
          throw new ProfileError(
            "PROFILE_VERSION_LIMIT_REACHED",
            "The profile holds the most versions it may.",
            { maximum: VERSIONS_PER_PROFILE_MAX },
          );
      }
    },
  };
}
