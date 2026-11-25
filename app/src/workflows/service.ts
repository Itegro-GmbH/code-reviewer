// SPDX-License-Identifier: LicenseRef-Proprietary

// The service behind the workflow routes (#833): validate a document without storing it, and list, read, create, save new
// versions of and archive the workflows of ONE workspace. Who may call is the route's (`withWorkspace`); every rule about the data is here.
// Saving runs the validator first, with the environments of the workspace, and refuses an invalid document with the same list of
// errors the validate call gives. The document is stored as the JSON text that was validated; every save is a new version.
import type { McpOAuthRepository } from "../db/repositories/mcp-oauth-repository.ts";
import type { McpServersRepository } from "../db/repositories/mcp-servers-repository.ts";
import type { ImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import type { NamedRunnersRepository } from "../db/repositories/named-runners-repository.ts";
import type { ProfilesRepository } from "../db/repositories/profiles-repository.ts";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import type { ProjectsRepository } from "../db/repositories/projects-repository.ts";
import type {
  StoredWorkflow,
  StoredWorkflowVersion,
  WorkflowsRepository,
} from "../db/repositories/workflows-repository.ts";
import {
  BUILT_IN_ROLES,
  BUILT_IN_RUNNER_VCPUS,
  builtInLaneDocument,
  LANE_COPY_FAILED,
  type BuiltInAgentSettings,
  type BuiltInLaneKey,
  type BuiltInRole,
  type LaneStatuses,
} from "./built-in-lanes.ts";
import {
  WorkflowError,
  type WorkflowErrorCode,
  type WorkflowRequestIssue,
} from "./errors.ts";
import type { OnlineRunner } from "../runner-identity/announced.ts";
import { issue, type Issue } from "./issues.ts";
import {
  ARCHIVED_WORKFLOWS_PER_WORKSPACE_MAX,
  BUDGET_OPERATOR_MAX_USD,
  CHANGE_DESCRIPTION_MAX_LENGTH,
  DOCUMENT_MAX_BYTES,
  STEPS_MAX,
  VERSIONS_PER_WORKFLOW_MAX,
  WORKFLOW_ID_MAX_LENGTH,
  WORKFLOWS_PER_PROJECT_MAX,
} from "./limits.ts";
import { TARGET_ROOTS, type TargetRoot } from "./connectors.ts";
import { isRevoked } from "../named-runners/types.ts";
import { inlineModelsIn, runnerIdsIn } from "./agent-settings.ts";
import { isRecord, textLength } from "./json.ts";
import { mcpServersNamedBy } from "./mcp.ts";
import { profileInfosOf, profileRefsIn } from "./profile-refs.ts";
import {
  REACH_WANTS,
  reachAt,
  type ReachSamples,
  type ReachWants,
  type ScopeAnswer,
} from "./reach.ts";
import {
  createResolver,
  type McpServerInfo,
  type RunnerInfo,
  type WorkflowResolver,
} from "./resolver.ts";
import { validateWorkflow, type ValidationResult } from "./validate.ts";

export type WorkflowSummaryView = {
  id: string;
  /** The project the lane belongs to (#922); null for a lane no project could take. */
  projectId: string | null;
  name: string;
  /** The current version. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** When the workflow was archived: not listed, takes no new version, never started. `null` while it is not. */
  archivedAt: string | null;
};

export type WorkflowList = {
  workflows: WorkflowSummaryView[];
  /** How many workflows the workspace may hold. */
  maximum: number;
};

/** What copying one built-in lane into a project came to (#922): the lane that was saved, or why it was not. */
export type BuiltInLaneResult =
  | { key: BuiltInLaneKey; ok: true; workflow: WorkflowSummaryView }
  | {
      key: BuiltInLaneKey;
      ok: false;
      /** A `WorkflowError`'s code, or `LANE_COPY_FAILED` for a failure no lane has a code for (the others are still copied). */
      code: WorkflowErrorCode | typeof LANE_COPY_FAILED;
      errors: readonly Issue[];
    };

export type WorkflowVersionInfo = {
  version: number;
  savedAt: string;
  /** Who saved it: the id of the user. */
  savedBy: string;
  /**
   * What it changed against the version before (#1107). Null for version 1, whose text is the lane's description, and for a version
   * saved before change descriptions existed.
   */
  changeDescription: string | null;
};

export type WorkflowView = WorkflowSummaryView & {
  /** The version the `document` is: the current one unless an older was asked for. */
  documentVersion: number;
  document: unknown;
  /** Every saved version, the newest first. */
  versions: WorkflowVersionInfo[];
};

export type WorkflowService = {
  /** Checks a document against the format and the workspace's environments. Stores nothing. */
  validate(body: unknown): Promise<ValidationResult>;
  /**
   * The values a step of an unsaved document can reach (#927), by the validator's own scope rules. The body is
   * `{ document, at, targetRoots?, wants?, workflowId? }`: `at` is a JSON pointer into the document, `targetRoots` the roots a target input
   * takes (only those values are listed), `workflowId` the lane whose latest run gives the samples.
   */
  scope(body: unknown): Promise<ScopeAnswer>;
  /** The lanes of one project (#922). Throws `WORKFLOW_PROJECT_REQUIRED` when `projectId` is missing or no project of the workspace. */
  list(projectId: string | undefined): Promise<WorkflowList>;
  /** The workflow with its current version, or with the version asked for. */
  get(id: string, version?: number): Promise<WorkflowView>;
  /** Saves a new lane in a project (#922); the project must be one of the workspace and switched on. */
  create(
    user: { id: string },
    projectId: string | undefined,
    body: unknown,
  ): Promise<WorkflowView>;
  /**
   * Copies built-in lanes into a project (#922), each as a lane like any other: its agent steps carry their settings inline (#1105, ADR 0007),
   * taken from the profiles `implementer@1` and `reviewer@1` of the workspace, on the workspace's hosted runner of 4 vCPU; validated, then saved
   * as version 1. A lane that does not pass (a profile or the runner is missing) or whose name the project has is reported and the others
   * are still copied.
   */
  copyBuiltIn(
    user: { id: string },
    projectId: string,
    keys: readonly BuiltInLaneKey[],
    statuses?: LaneStatuses,
    /** The provider of the project's ticket source (#1040): the lanes word their pull request for it. Left out: `github`. */
    provider?: string,
  ): Promise<BuiltInLaneResult[]>;
  /**
   * Saves `body` as the next version. `expectedVersion`: only if that is still the current one. `body` is the document plus a root key
   * `changeDescription` (#1107): 1 to 1,000 characters saying what this version changes against the one before, not only white space;
   * without it the save is `WORKFLOW_CHANGE_DESCRIPTION_REQUIRED`. It is stored with the version, not in the document.
   */
  update(
    user: { id: string },
    id: string,
    body: unknown,
    expectedVersion?: number,
  ): Promise<WorkflowView>;
  /**
   * Archives a workflow: it leaves the list and the count of the workspace, takes no new version and is not started; its name is
   * free again and its versions stay readable. Asked again, it answers the same. A workspace holds a bounded number of archived
   * workflows: past it, an archive is `WORKFLOW_ARCHIVE_LIMIT_REACHED`.
   */
  archive(id: string): Promise<WorkflowView>;
};

export type WorkflowServiceDependencies = {
  workflows: WorkflowsRepository;
  /** The projects of the workspace (#922): a lane belongs to one of them. */
  projects: Pick<ProjectsRepository, "getById" | "list">;
  environments: ImplementerEnvironmentsRepository;
  /** The profiles of the workspace (#843): the names and versions a step may run, and what a version is (may it push, its default result). */
  profiles: Pick<
    ProfilesRepository,
    "list" | "versionFacts" | "archivedNames" | "findByName"
  >;
  /**
   * #1052: the MCP servers of the workspace, so a lane can name only those and the validator can say which are broken. Left out: the
   * workspace has none, and a lane that names a server is refused (it fails closed).
   */
  mcpServers?: Pick<McpServersRepository, "list">;
  /** #1051: the OAuth connections of those servers, so the validator can warn about one that is broken or not connected. */
  mcpOAuth?: Pick<McpOAuthRepository, "list">;
  /**
   * #973: the runners of the workspace that are online now, with what each announces, so the validator can refuse a profile no runner
   * announces (`no_runner_announces`). Left out: the validator does not ask.
   */
  onlineRunners?: () => Promise<readonly OnlineRunner[]>;
  /**
   * #1150: whether the workspace has a Claude Code OAuth token it can use, so the validator lets a step on the harness `claude-code` run on a
   * hosted environment or runner. Left out: the workspace has none.
   */
  claudeCodeTokenConfigured?: () => Promise<boolean>;
  /**
   * #1105 (ADR 0007): the concrete runners of the workspace, so a step can name only one of them (`runner_unknown`) and the rules of a
   * runner are judged at the one it names. Left out: the workspace's runners are not known, and a step that names one is refused.
   */
  runners?: Pick<NamedRunnersRepository, "list" | "find">;
  /**
   * #1105: the rule of the Implementer form for a model, as the claim applies it, so the model of a step with settings of its own is held to
   * what a profile's model is held to when it is saved (`model_not_allowed`). Left out: such a model is not checked against the workspace.
   */
  models?: { check(choice: ModelChoice): Promise<string | null> };
  /** The most a workflow may be given to spend. Until the operator can set it: `BUDGET_OPERATOR_MAX_USD`. */
  maxBudgetUsd?: number;
  /** The most archived workflows a workspace may hold: `ARCHIVED_WORKFLOWS_PER_WORKSPACE_MAX`. */
  archivedMax?: number;
  /** What the latest run of a workflow held, for the samples of the scope lookup (#927); none: no samples. */
  samples?: (workflowId: string) => Promise<ReachSamples | undefined>;
};

function summaryOf(workflow: StoredWorkflow): WorkflowSummaryView {
  return {
    id: workflow.id,
    projectId: workflow.projectId,
    name: workflow.name,
    version: workflow.version,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    archivedAt: workflow.archivedAt,
  };
}

/** The servers of the workspace as the validator sees them: the last test, and for an OAuth server the state of its connection. */
async function mcpServerInfos(
  servers: Pick<McpServersRepository, "list">,
  oauth: Pick<McpOAuthRepository, "list"> | undefined,
): Promise<McpServerInfo[]> {
  const [list, connections] = await Promise.all([
    servers.list(),
    oauth === undefined ? Promise.resolve([]) : oauth.list(),
  ]);
  const byServer = new Map(
    connections.map((connection) => [connection.serverId, connection.status]),
  );
  return list.map((server) => ({
    id: server.id,
    name: server.name,
    status: server.testStatus,
    ...(server.authKind === "oauth"
      ? { oauth: byServer.get(server.id) ?? ("unconnected" as const) }
      : {}),
  }));
}

/** The most distinct runner ids of a document that are looked up one by one (a revoked runner is no part of the list). */
const RUNNER_LOOKUPS_MAX = STEPS_MAX + 1;

/**
 * The runners of the workspace as the validator sees them: the list (hosted runners, then the self-hosted ones that are not revoked), and
 * a revoked runner the document names (found by its id, so the answer is "revoked" and not "unknown").
 */
async function runnerInfos(
  runners: Pick<NamedRunnersRepository, "list" | "find">,
  document: unknown,
): Promise<RunnerInfo[]> {
  const listed = await runners.list();
  const known = new Set(listed.map((runner) => runner.id));
  const infos: RunnerInfo[] = listed.map((runner) => ({
    id: runner.id,
    name: runner.name,
    kind: runner.kind,
  }));
  for (const id of runnerIdsIn(document, RUNNER_LOOKUPS_MAX)) {
    if (known.has(id)) continue;
    const found = await runners.find(id);
    if (found !== undefined && isRevoked(found))
      infos.push({
        id: found.id,
        name: found.name,
        kind: found.kind,
        revoked: true,
      });
  }
  return infos;
}

type AgentSettingsOutcome =
  { ok: true; settings: BuiltInAgentSettings } | { ok: false; issue: Issue };

/** The profile each built-in role copies its settings from, at the version the built-in lanes have always named. */
const BUILT_IN_PROFILES: Record<BuiltInRole, string> = {
  implementer: "implementer",
  reviewer: "reviewer",
};

/**
 * The settings of a built-in agent (#1105, ADR 0007): what the profile `implementer@1` or `reviewer@1` of the workspace holds (the harness,
 * the model, the push right, the instructions) and the id of the workspace's hosted runner of 4 vCPU. The profile and the runner are
 * what the built-in lanes needed before, so a workspace that could copy them can still; a missing one is the validator's own answer.
 *
 * RELEASE B FOLLOW-UP (ADR 0007): the profile pages and routes go away in release B, and then `implementer@1` / `reviewer@1` can no longer be
 * made, so this copy can never succeed for a workspace that lacks them (`profile_unknown` at `/steps`). Release B must first give the built-in
 * lanes another source of settings (instance-level defaults, or settings stored with the built-in lane). Until then this is the source.
 *
 * A built-in lane goes through `createLane`, so it also meets the model rule of a save (`model_not_allowed`): a profile's model that the
 * workspace cannot run any more refuses the copy of the lane, which the profile form did not (its rule ran when the profile was saved).
 * Project creation reports it per lane exactly like `profile_unknown`: `{ key, ok: false, code: "WORKFLOW_INVALID" }`, and the others
 * are still copied.
 */
async function builtInSettings(
  role: BuiltInRole,
  profiles: Pick<ProfilesRepository, "findByName">,
  runners: Pick<NamedRunnersRepository, "list"> | undefined,
): Promise<AgentSettingsOutcome> {
  const name = BUILT_IN_PROFILES[role];
  const found = await profiles.findByName(name, 1);
  if (found === undefined)
    return {
      ok: false,
      issue: issue(
        "/steps",
        "profile_unknown",
        `The built-in lanes take the settings of their agents from the profile '${name}@1' of the workspace, and there is none (an archived profile does not count). Create it, or write the lane yourself.`,
      ),
    };
  const hosted = (await runners?.list())?.find(
    (runner) =>
      runner.kind === "hosted" && runner.vcpus === BUILT_IN_RUNNER_VCPUS,
  );
  if (hosted === undefined)
    return {
      ok: false,
      issue: issue(
        "/steps",
        "runner_unknown",
        `The built-in lanes run on the hosted runner of ${String(BUILT_IN_RUNNER_VCPUS)} vCPU, and the workspace has none.`,
      ),
    };
  const { content } = found.version;
  return {
    ok: true,
    settings: {
      harness: content.harness ?? "opencode",
      model: content.model,
      canPush: content.canPush,
      instructions: content.instructions,
      runner: hosted.id,
    },
  };
}

export function createWorkflowService({
  workflows,
  projects,
  environments,
  profiles,
  mcpServers,
  mcpOAuth,
  onlineRunners,
  claudeCodeTokenConfigured,
  runners,
  models,
  maxBudgetUsd = BUDGET_OPERATOR_MAX_USD,
  archivedMax = ARCHIVED_WORKFLOWS_PER_WORKSPACE_MAX,
  samples,
}: WorkflowServiceDependencies): WorkflowService {
  /** The resolver of the workspace for a document: its environments, and the profiles (with the facts) the document runs. */
  async function resolverFor(body: unknown): Promise<WorkflowResolver> {
    const known = await environments.listSummaries();
    // The profiles of the workspace, with the facts of the versions the document runs and no others.
    const live = (await profiles.list()).map((profile) => ({
      id: profile.id,
      name: profile.name,
      version: profile.version,
    }));
    const { wanted, build } = profileInfosOf(live, profileRefsIn(body));
    const facts = await profiles.versionFacts(wanted);
    // #1105: the models the steps name themselves, each asked once in this one pass (the checker behind `models` is built once per
    // service). More than `STEPS_MAX` distinct models means more steps than a document may have: the validator refuses it for that, so
    // nothing is looked up and nothing is accepted that should not be.
    const verdicts = new Map<string, string | null>();
    if (models !== undefined) {
      const named = inlineModelsIn(body, STEPS_MAX + 1);
      if (named.length <= STEPS_MAX)
        for (const model of named)
          verdicts.set(JSON.stringify(model), await models.check(model));
    }
    return createResolver({
      ...(models === undefined
        ? {}
        : { modelCheck: (model) => verdicts.get(JSON.stringify(model)) }),
      environments: known,
      profiles: build(facts),
      archivedProfiles: await profiles.archivedNames(),
      ...(mcpServers === undefined || mcpServersNamedBy(body).length === 0
        ? {}
        : {
            mcpServers: await mcpServerInfos(mcpServers, mcpOAuth),
          }),
      ...(onlineRunners === undefined
        ? {}
        : { onlineRunners: await onlineRunners() }),
      // One read of one row.
      ...(claudeCodeTokenConfigured === undefined
        ? {}
        : { claudeCodeToken: await claudeCodeTokenConfigured() }),
      ...(runners === undefined
        ? {}
        : { runners: await runnerInfos(runners, body) }),
    });
  }

  async function validateDocument(body: unknown): Promise<ValidationResult> {
    return validateWorkflow(body, await resolverFor(body), { maxBudgetUsd });
  }

  const badScope = (
    issue: WorkflowRequestIssue,
    message: string,
  ): WorkflowError =>
    new WorkflowError("WORKFLOW_REQUEST_INVALID", message, {
      issues: [issue],
    });

  async function scopeOf(body: unknown): Promise<ScopeAnswer> {
    if (!isRecord(body) || typeof body.at !== "string")
      throw badScope(
        {
          path: "at",
          code: "body_invalid",
          message:
            "The body is {document, at}: at is the JSON pointer of the step, like /steps/1.",
          available: [],
        },
        "The body must be an object with document and at.",
      );
    const roots = body.targetRoots;
    if (
      roots !== undefined &&
      (!Array.isArray(roots) ||
        !roots.every(
          (root): root is TargetRoot =>
            typeof root === "string" &&
            (TARGET_ROOTS as readonly string[]).includes(root),
        ))
    )
      throw badScope(
        {
          path: "targetRoots",
          code: "scope_target_unknown",
          message: "targetRoots is a list of the roots a target input takes.",
          available: [...TARGET_ROOTS],
        },
        "targetRoots names a root the format does not have.",
      );
    const wants = body.wants;
    if (
      wants !== undefined &&
      !(REACH_WANTS as readonly unknown[]).includes(wants)
    )
      throw badScope(
        {
          path: "wants",
          code: "scope_wants_unknown",
          message:
            "wants is the kind of value the field takes: text, comparable or emptiable.",
          available: [...REACH_WANTS],
        },
        "wants names a kind of value the format does not have.",
      );
    const workflowId =
      typeof body.workflowId === "string" &&
      body.workflowId.length > 0 &&
      body.workflowId.length <= WORKFLOW_ID_MAX_LENGTH
        ? body.workflowId
        : undefined;
    const held =
      workflowId === undefined ? undefined : await samples?.(workflowId);
    const reach = reachAt(
      body.document,
      await resolverFor(body.document),
      body.at,
      {
        maxBudgetUsd,
        ...(roots === undefined
          ? {}
          : { target: { input: "this field", roots: roots as TargetRoot[] } }),
        ...(wants === undefined ? {} : { wants: wants as ReachWants }),
        ...(held === undefined ? {} : { samples: held }),
      },
    );
    if (reach === undefined)
      throw badScope(
        {
          path: "at",
          code: "scope_at_unknown",
          message: "at is not a step of the document.",
          available: [],
        },
        "at is not a step of the document.",
      );
    return { ...reach, sampled: held !== undefined };
  }

  async function viewOf(
    workflow: StoredWorkflow,
    shown: StoredWorkflowVersion,
  ): Promise<WorkflowView> {
    const versions = await workflows.listVersions(workflow.id);
    return {
      ...summaryOf(workflow),
      documentVersion: shown.version,
      document: JSON.parse(shown.document) as unknown,
      versions: versions.map((v) => ({
        version: v.version,
        savedAt: v.createdAt,
        savedBy: v.createdBy,
        changeDescription: v.changeDescription,
      })),
    };
  }

  /**
   * Validates and returns the text to store, and the MCP servers it names (the save locks them); a document the validator refuses is
   * `WORKFLOW_INVALID` with every error.
   */
  async function acceptable(body: unknown): Promise<{
    name: string;
    text: string;
    mcpServerIds: string[];
    refusedWithout: (missing: readonly string[]) => WorkflowError;
  }> {
    const resolver = await resolverFor(body);
    const result = validateWorkflow(body, resolver, { maxBudgetUsd });
    if (!result.valid)
      throw new WorkflowError(
        "WORKFLOW_INVALID",
        "The workflow does not pass the validator.",
        { errors: result.errors, truncated: result.truncated },
      );
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text, "utf8") > DOCUMENT_MAX_BYTES)
      throw new WorkflowError(
        "WORKFLOW_BODY_TOO_LARGE",
        "The workflow is too large.",
      );
    return {
      name: (body as { name: string }).name,
      text,
      mcpServerIds: mcpServersNamedBy(body),
      // A server that was removed after the check and before the save (the save found it missing): the same answer the check would
      // have given a moment later, with the places.
      refusedWithout: (missing) => {
        const gone = new Set(missing);
        const again = validateWorkflow(
          body,
          {
            ...resolver,
            mcpServers: () =>
              (resolver.mcpServers?.() ?? []).filter(
                (server) => !gone.has(server.id),
              ),
          },
          { maxBudgetUsd },
        );
        return new WorkflowError(
          "WORKFLOW_INVALID",
          "The workflow does not pass the validator.",
          { errors: again.errors, truncated: again.truncated },
        );
      },
    };
  }

  /**
   * A lane is created with a description of its own (#1107): it is what version 1 says. The schema leaves it optional (a lane saved
   * before has none), so the rule is the save's, not the validator's.
   */
  function requireDescription(body: unknown): void {
    const description = isRecord(body) ? body.description : undefined;
    if (typeof description === "string" && description.trim() !== "") return;
    throw new WorkflowError(
      "WORKFLOW_INVALID",
      "The workflow does not pass the validator.",
      {
        errors: [
          issue(
            "/description",
            "missing_field",
            "A new lane needs a 'description': what the lane does, in a sentence or two. It is what version 1 says.",
          ),
        ],
        truncated: false,
      },
    );
  }

  const changeDescriptionRequired = (): WorkflowError =>
    new WorkflowError(
      "WORKFLOW_CHANGE_DESCRIPTION_REQUIRED",
      `A new version needs 'changeDescription' next to the document: 1 to ${CHANGE_DESCRIPTION_MAX_LENGTH} characters saying what changed against the version before, not only white space.`,
    );

  /** Takes the root key `changeDescription` off the body of a save (#1107): the document is what the validator and the engine read. */
  function splitChangeDescription(body: unknown): {
    document: unknown;
    changeDescription: string;
  } {
    if (!isRecord(body)) throw changeDescriptionRequired();
    const { changeDescription, ...document } = body;
    const text =
      typeof changeDescription === "string" ? changeDescription.trim() : "";
    // Postgres refuses NUL in a text column; refusing it here keeps the answer a 422 instead of a failed insert.
    if (
      text === "" ||
      text.includes("\u0000") ||
      textLength(text) > CHANGE_DESCRIPTION_MAX_LENGTH
    )
      throw changeDescriptionRequired();
    return { document, changeDescription: text };
  }

  const notFound = (): WorkflowError =>
    new WorkflowError("WORKFLOW_NOT_FOUND", "There is no such workflow.");

  /** The project of the request: one of this workspace, or the refusal that names what is missing and which projects there are. */
  async function projectOf(projectId: string | undefined) {
    const project =
      projectId === undefined || projectId === ""
        ? undefined
        : await projects.getById(projectId);
    if (project !== undefined) return project;
    const available = (await projects.list()).flatMap((entry) =>
      entry.project === null ? [] : [entry.project.id],
    );
    throw new WorkflowError(
      projectId === undefined || projectId === ""
        ? "WORKFLOW_PROJECT_REQUIRED"
        : "WORKFLOW_PROJECT_NOT_FOUND",
      projectId === undefined || projectId === ""
        ? "A lane belongs to a project: name it with projectId."
        : "There is no such project in this workspace.",
      {
        issues: [
          {
            path: "projectId",
            code:
              projectId === undefined || projectId === ""
                ? "project_required"
                : "project_unknown",
            message:
              projectId === undefined || projectId === ""
                ? "projectId is required: the lanes are listed and created within one project."
                : "projectId is not a project of this workspace.",
            available: available.slice(0, 50),
          },
        ],
      },
    );
  }

  function checkId(id: string): void {
    if (id.length === 0 || id.length > WORKFLOW_ID_MAX_LENGTH) throw notFound();
  }

  async function createLane(
    user: { id: string },
    projectId: string | undefined,
    body: unknown,
  ): Promise<WorkflowView> {
    const project = await projectOf(projectId);
    if (!project.active)
      throw new WorkflowError(
        "WORKFLOW_PROJECT_INACTIVE",
        "The project is switched off and takes no new lane.",
      );
    const { name, text, mcpServerIds, refusedWithout } = await acceptable(body);
    requireDescription(body);
    const created = await workflows.create(
      {
        name,
        document: text,
        createdBy: user.id,
        projectId: project.id,
        mcpServerIds,
      },
      WORKFLOWS_PER_PROJECT_MAX,
    );
    if (!created.ok) {
      if (created.reason === "mcp_server_missing")
        throw refusedWithout(created.missing ?? []);
      // Cannot happen after `projectOf`, which read the project of this workspace; the repository says it anyway.
      if (created.reason === "project_not_found")
        throw new WorkflowError(
          "WORKFLOW_PROJECT_NOT_FOUND",
          "There is no such project in this workspace.",
          {
            issues: [
              {
                path: "projectId",
                code: "project_unknown",
                message: "projectId is not a project of this workspace.",
                available: [],
              },
            ],
          },
        );
      if (created.reason === "name_taken")
        throw new WorkflowError(
          "WORKFLOW_NAME_TAKEN",
          "The project has a lane of that name.",
        );
      throw new WorkflowError(
        "WORKFLOW_LIMIT_REACHED",
        "The project holds the most workflows it may.",
        { maximum: WORKFLOWS_PER_PROJECT_MAX },
      );
    }
    return viewOf(created.workflow, created.saved);
  }

  return {
    validate: validateDocument,

    scope: scopeOf,

    async list(projectId) {
      const project = await projectOf(projectId);
      return {
        workflows: (await workflows.list({ projectId: project.id })).map(
          summaryOf,
        ),
        maximum: WORKFLOWS_PER_PROJECT_MAX,
      };
    },

    async get(id, version) {
      checkId(id);
      const found = await workflows.get(id);
      if (found === undefined) throw notFound();
      if (version === undefined || version === found.current.version)
        return viewOf(found.workflow, found.current);
      const older = await workflows.getVersion(id, version);
      if (older === undefined)
        throw new WorkflowError(
          "WORKFLOW_VERSION_NOT_FOUND",
          "The workflow has no such version.",
        );
      return viewOf(found.workflow, older);
    },

    create: createLane,

    async copyBuiltIn(user, projectId, keys, statuses, provider) {
      const roles = new Map<BuiltInRole, Promise<AgentSettingsOutcome>>();
      const agentOf = (role: BuiltInRole): Promise<AgentSettingsOutcome> => {
        let found = roles.get(role);
        if (found === undefined) {
          found = builtInSettings(role, profiles, runners);
          roles.set(role, found);
        }
        return found;
      };
      const results: BuiltInLaneResult[] = [];
      for (const key of keys) {
        try {
          const needed = await Promise.all(
            BUILT_IN_ROLES[key].map(
              async (role) => [role, await agentOf(role)] as const,
            ),
          );
          const failed = needed.flatMap(([, outcome]) =>
            outcome.ok ? [] : [outcome.issue],
          );
          if (failed.length > 0) {
            results.push({
              key,
              ok: false,
              code: "WORKFLOW_INVALID",
              errors: failed,
            });
            continue;
          }
          const settings = Object.fromEntries(
            needed.map(([role, outcome]) => [
              role,
              outcome.ok ? outcome.settings : undefined,
            ]),
          ) as Partial<Record<BuiltInRole, BuiltInAgentSettings>>;
          // A lane without an agent of one role (the review lane has no implementer) is not given that role's settings.
          const fallback = (settings.implementer ??
            settings.reviewer) as BuiltInAgentSettings;
          const view = await createLane(
            user,
            projectId,
            builtInLaneDocument(
              key,
              {
                implementer: settings.implementer ?? fallback,
                reviewer: settings.reviewer ?? fallback,
              },
              statuses,
              provider,
            ),
          );
          results.push({
            key,
            ok: true,
            workflow: {
              id: view.id,
              projectId: view.projectId,
              name: view.name,
              version: view.version,
              createdAt: view.createdAt,
              updatedAt: view.updatedAt,
              archivedAt: view.archivedAt,
            },
          });
        } catch (error) {
          // One lane failing - a database error after the lane before was saved - is that lane's failure, never the failure of the others.
          if (!(error instanceof WorkflowError)) {
            // The lane and the code of the failure (a database error's own code, else its name), never its text.
            const code =
              isRecord(error) && typeof error.code === "string"
                ? error.code
                : error instanceof Error
                  ? error.name
                  : "unknown";
            console.error(
              `[workflows] copying the built-in lane ${key} failed (${code})`,
            );
            results.push({
              key,
              ok: false,
              code: LANE_COPY_FAILED,
              errors: [],
            });
            continue;
          }
          results.push({
            key,
            ok: false,
            code: error.code,
            errors: error.errors,
          });
        }
      }
      return results;
    },

    async archive(id) {
      checkId(id);
      const archived = await workflows.archive(id, archivedMax);
      if (!archived.ok) {
        if (archived.reason === "limit_reached")
          throw new WorkflowError(
            "WORKFLOW_ARCHIVE_LIMIT_REACHED",
            "The workspace holds the most archived workflows it may.",
            { maximum: archivedMax },
          );
        throw notFound();
      }
      const found = await workflows.get(id);
      if (found === undefined) throw notFound();
      return viewOf(found.workflow, found.current);
    },

    async update(user, id, body, expectedVersion) {
      checkId(id);
      const { document, changeDescription } = splitChangeDescription(body);
      const { name, text, mcpServerIds, refusedWithout } =
        await acceptable(document);
      const saved = await workflows.saveVersion(
        id,
        {
          name,
          document: text,
          changeDescription,
          createdBy: user.id,
          mcpServerIds,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        },
        VERSIONS_PER_WORKFLOW_MAX,
      );
      if (saved.ok) return viewOf(saved.workflow, saved.saved);
      switch (saved.reason) {
        case "not_found":
          throw notFound();
        case "archived":
          throw new WorkflowError(
            "WORKFLOW_ARCHIVED",
            "The workflow is archived and takes no new version.",
          );
        case "name_taken":
          throw new WorkflowError(
            "WORKFLOW_NAME_TAKEN",
            "The project has a lane of that name.",
          );
        case "version_conflict":
          throw new WorkflowError(
            "WORKFLOW_VERSION_CONFLICT",
            "The workflow was saved since that version.",
            { current: saved.current },
          );
        case "version_limit_reached":
          throw new WorkflowError(
            "WORKFLOW_VERSION_LIMIT_REACHED",
            "The workflow holds the most versions it may.",
            { maximum: VERSIONS_PER_WORKFLOW_MAX },
          );
        case "mcp_server_missing":
          throw refusedWithout(saved.missing ?? []);
      }
    },
  };
}
