// SPDX-License-Identifier: LicenseRef-Proprietary

// The lane conversion of release A (#1105, ADR 0007, "Migration path", steps 2 to 4), as a job the operator runs against a database:
// for every workspace, every lane that is not archived either gets a new version with the profile values and the runner written into
// its steps, or is listed with the reasons it did not. It is an app-side job, not a SQL migration, because it needs what the app knows
// (the profiles, the environments, the runners and above all the validator of a save), and a migration is frozen and imports none of that
// (`db/migrations/support`). It is safe to run again: a lane whose steps hold no profile and no environment is skipped, and a lane that
// was converted is such a lane. Runs and older versions are never touched: a run holds the version it started with.
//
// A dry run does everything but the writes: it reads, converts and validates exactly as a real run does and says what it would do. (A
// workspace that lacks a hosted runner type gets it made when its runners are read, as it does when any page lists them: that is the
// platform repairing itself and the only write a dry run can cause.)
//
// What a run never does, on purpose, and says in its report:
//  - It does not check the model rule of a save (`model_not_allowed`). That check (`implementerModelsFor`) reads the workspace's keys,
//    which means decrypting them with the app secret, and the entitlements and catalogs of the running app: a script run with the migrate
//    URL has neither the secret nor the wiring, and must not have them. A converted step keeps the model its profile ran with (the claim
//    refuses one that is gone at the run, as it did before), and every converted lane is listed under the warning `model_unchecked` with
//    the steps and models, so the operator sees which lanes a later save in the app could refuse.
//  - It does not cover a workspace it was not asked about: a run with `--workspace` says so in its report and is never the gate of release B.
//
// The environments and runners a lane is converted against are read again for every lane (a few small queries), so a change an owner makes
// while the job runs is seen by the next lane; the profiles were always read live. The save re-reads the runners itself.
import type { Kysely } from "kysely";
import { errorCode } from "../db/errors.ts";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createMcpOAuthRepository } from "../db/repositories/mcp-oauth-repository.ts";
import { createMcpServersRepository } from "../db/repositories/mcp-servers-repository.ts";
import { createNamedRunnersRepository } from "../db/repositories/named-runners-repository.ts";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import {
  createWorkflowsRepository,
  type StoredWorkflow,
} from "../db/repositories/workflows-repository.ts";
import type { Database } from "../db/schema.ts";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import { WorkflowError } from "../workflows/errors.ts";
import { createWorkflowService } from "../workflows/service.ts";
import { CONVERSION_CHANGE_DESCRIPTION, convertDocument } from "./convert.ts";
import { progressLine } from "./format.ts";
import {
  LANE_OUTCOMES,
  type ConversionReason,
  type ConversionWorld,
  type EnvironmentValues,
  type LaneConversionReport,
  type LaneOutcome,
  type LaneReportEntry,
  type LaneWarning,
  type ProfileLookup,
  type WorkspaceFailure,
} from "./types.ts";

/** A run that cannot start: the stable code a caller branches on, and a sentence that names no secret. */
export class LaneConversionError extends Error {
  readonly code: "LANE_CONVERSION_WORKSPACE_NOT_FOUND";
  constructor(code: LaneConversionError["code"], message: string) {
    super(message);
    this.name = "LaneConversionError";
    this.code = code;
  }
}

export type LaneConversionOptions = {
  db: Kysely<Database>;
  /** Report only: nothing is saved or archived. */
  dryRun: boolean;
  /** Only this workspace. Left out: every workspace that is not deleted. */
  workspaceId?: string;
  /** Where an unexpected failure of one lane is noted (its database error code, never its text). Left out: `console.error`. */
  warn?: (line: string) => void;
  /**
   * Called with one line for every lane as soon as it is done (converted, archived, listed), so what a run did survives a crash of the
   * run: the line is out before the next lane is touched. Left out: nothing.
   */
  progress?: (line: string) => void;
};

/** A workspace may hold more archived lanes than the limit of a person's archive; the conversion archives past it rather than leave the lane. */
const NO_ARCHIVE_LIMIT = Number.MAX_SAFE_INTEGER;
/** The most issue codes a report names for one lane; the rest is "and more" in the message. */
const ISSUES_LISTED_MAX = 20;

async function workspaceIds(
  db: Kysely<Database>,
  only: string | undefined,
): Promise<string[]> {
  let query = db
    .selectFrom("workspaces")
    .select("id")
    .where("deleted_at", "is", null)
    .orderBy("id");
  if (only !== undefined) query = query.where("id", "=", only);
  return (await query.execute()).map((row) => row.id);
}

/**
 * What the conversion asks of one workspace's data, read through the repositories the app itself uses. Read for each lane, not once for
 * the workspace: a run over many lanes can last, and an environment an owner changed or a runner an owner revoked meanwhile is seen by
 * the next lane.
 */
async function worldOf(
  repositories: ReturnType<typeof repositoriesOf>,
): Promise<ConversionWorld> {
  const live = new Set(
    (await repositories.profiles.list()).map((profile) => profile.name),
  );
  const archived = new Set(await repositories.profiles.archivedNames());
  const environments = await repositories.environments.list();
  const runners = await repositories.runners.list();
  const hosted = runners.flatMap((runner) =>
    runner.kind === "hosted"
      ? [{ id: runner.id, name: runner.name, vcpus: runner.vcpus }]
      : [],
  );
  const selfHosted = runners.flatMap((runner) =>
    runner.kind === "self_hosted"
      ? [{ id: runner.id, name: runner.name, labels: runner.labels }]
      : [],
  );
  const environmentValues = (
    environment: (typeof environments)[number],
  ): EnvironmentValues => ({
    id: environment.id,
    name: environment.name,
    kind: environment.kind,
    vcpus: environment.vcpus,
    setupScript: environment.setupScript,
    labels: environment.labels,
    network: environment.network,
  });
  const world: ConversionWorld = {
    async profile(name, version): Promise<ProfileLookup> {
      const found = await repositories.profiles.findByName(name, version);
      if (found !== undefined)
        return {
          kind: "found",
          profile: {
            name,
            version: found.version.version,
            description: found.version.content.description,
            model: found.version.content.model,
            instructions: found.version.content.instructions,
            canPush: found.version.content.canPush,
            defaultResult: found.version.content.defaultResult,
            harness: found.version.content.harness ?? "opencode",
            environmentId: found.version.content.environmentId ?? null,
          },
        };
      if (live.has(name)) return { kind: "version_missing" };
      return { kind: archived.has(name) ? "archived" : "missing" };
    },
    environment: ({ id, name }) => {
      const found =
        id !== undefined
          ? environments.find((environment) => environment.id === id)
          : environments.find(
              (environment) =>
                name !== undefined &&
                environment.name.toLowerCase() === name.toLowerCase(),
            );
      return Promise.resolve(
        found === undefined ? undefined : environmentValues(found),
      );
    },
    hostedRunners: () => hosted,
    selfHostedRunners: () => selfHosted,
  };
  return world;
}

function repositoriesOf(db: Kysely<Database>, workspaceId: string) {
  return {
    workflows: createWorkflowsRepository(db, workspaceId),
    projects: createProjectsRepository(db, workspaceId),
    environments: createImplementerEnvironmentsRepository(db, workspaceId),
    profiles: createProfilesRepository(db, workspaceId),
    runners: createNamedRunnersRepository(db, workspaceId),
    mcpServers: createMcpServersRepository(db, workspaceId),
    mcpOAuth: createMcpOAuthRepository(db, workspaceId),
  };
}

const issuesOf = (
  errors: readonly { code: string; path: string }[],
): { code: string; path: string }[] =>
  errors
    .slice(0, ISSUES_LISTED_MAX)
    .map((error) => ({ code: error.code, path: error.path }));

function validationReason(
  errors: readonly { code: string; path: string }[],
): ConversionReason {
  const more = errors.length > ISSUES_LISTED_MAX;
  return {
    code: "validation_failed",
    message: `The converted document does not pass the validator of a save${more ? ` (the first ${String(ISSUES_LISTED_MAX)} issues are listed)` : ""}. The lane keeps its version.`,
    issues: issuesOf(errors),
  };
}

/** The reason a refused save is. A failure with no code of the lane's own is `save_failed`. */
function saveFailure(
  error: unknown,
  warn: (line: string) => void,
  lane: string,
): ConversionReason {
  if (error instanceof WorkflowError) {
    if (error.code === "WORKFLOW_INVALID")
      return validationReason(
        (error.errors ?? []).map((e) => ({ code: e.code, path: e.path })),
      );
    if (error.code === "WORKFLOW_VERSION_CONFLICT")
      return {
        code: "version_conflict",
        message:
          "The lane was saved while it was converted. Run the conversion again.",
      };
    if (error.code === "WORKFLOW_VERSION_LIMIT_REACHED")
      return {
        code: "version_limit_reached",
        message: "The lane holds the most versions it may.",
      };
    return {
      code: "save_failed",
      message: `The save was refused (${error.code}).`,
    };
  }
  // The cause is not repeated: it could carry a connection string.
  warn(
    `[lanes:convert] lane ${lane}: the save failed (${errorCode(error) ?? (error instanceof Error ? error.name : "unknown")})`,
  );
  return {
    code: "save_failed",
    message: "The save failed in the database. See the log; run it again.",
  };
}

/** A model as the report names it: the provider and model id, or the id of the catalog entry. Never a key. */
function describeModel(model: ModelChoice): string {
  return "entryId" in model
    ? `catalog entry ${model.entryId}`
    : `${model.provider}/${model.model}`;
}

/** The warnings of a lane the conversion wrote (or would write): every model that came from a profile was not checked. */
function modelWarnings(
  models: readonly { stepId: string; model: ModelChoice }[],
): LaneWarning[] {
  return models.map(({ stepId, model }) => ({
    code: "model_unchecked",
    stepId,
    message: `The model of step ${stepId} (${describeModel(model)}) came from its profile and was not checked against the workspace's model rule; a later save of the lane in the app may refuse it (model_not_allowed).`,
  }));
}

const archivedWarning = (dryRun: boolean): LaneWarning => ({
  code: "archived_without_project",
  message: `The lane has no project and ${dryRun ? "would be" : "was"} archived. A trigger or an MCP assignment that still points at it no longer runs it: check them.`,
});

async function convertLane(
  lane: StoredWorkflow,
  repositories: ReturnType<typeof repositoriesOf>,
  service: ReturnType<typeof createWorkflowService>,
  options: LaneConversionOptions,
  warn: (line: string) => void,
): Promise<LaneReportEntry> {
  const entry = (
    outcome: LaneOutcome,
    rest: Partial<LaneReportEntry> = {},
  ): LaneReportEntry => ({
    workspaceId: lane.workspaceId,
    laneId: lane.id,
    laneName: lane.name,
    projectId: lane.projectId,
    outcome,
    reasons: [],
    warnings: [],
    ...rest,
  });
  if (lane.projectId === null) {
    if (options.dryRun)
      return entry("would_archive_without_project", {
        warnings: [archivedWarning(true)],
      });
    const archived = await repositories.workflows.archive(
      lane.id,
      NO_ARCHIVE_LIMIT,
    );
    if (archived.ok)
      return entry("archived_without_project", {
        warnings: [archivedWarning(false)],
      });
    if (archived.reason === "not_found") return entry("lane_gone");
    return entry("not_converted", {
      reasons: [
        {
          code: "save_failed",
          message: `The archive was refused (${archived.reason}).`,
        },
      ],
    });
  }
  const found = await repositories.workflows.get(lane.id);
  // Deleted, or archived by somebody, since the run listed it: nothing to convert, and not "already in the new form".
  if (found === undefined || found.workflow.archivedAt !== null)
    return entry("lane_gone");
  const { current } = found;
  let stored: unknown;
  try {
    stored = JSON.parse(current.document) as unknown;
  } catch {
    return entry("not_converted", {
      reasons: [
        {
          code: "document_unreadable",
          message: "The stored document is not JSON.",
        },
      ],
    });
  }
  const converted = await convertDocument(stored, await worldOf(repositories));
  if (converted.reasons.length > 0)
    return entry("not_converted", { reasons: converted.reasons });
  if (converted.document === undefined) return entry("already_inline");

  // The same validator a save uses, with the runner rules at the step's runner, but not its model rule (see the top of this file).
  // Any issue: no version.
  const checked = await service.validate(converted.document);
  if (!checked.valid)
    return entry("not_converted", {
      reasons: [validationReason(checked.errors)],
    });
  const warnings = modelWarnings(converted.models);
  if (options.dryRun)
    return entry("would_convert", {
      version: current.version + 1,
      steps: converted.steps,
      warnings,
    });
  try {
    const saved = await service.update(
      // The author of the version it replaces.
      { id: current.createdBy },
      lane.id,
      {
        ...converted.document,
        changeDescription: CONVERSION_CHANGE_DESCRIPTION,
      },
      current.version,
    );
    return entry("converted", {
      version: saved.version,
      steps: converted.steps,
      warnings,
    });
  } catch (error) {
    return entry("not_converted", {
      reasons: [saveFailure(error, warn, lane.id)],
    });
  }
}

/** The code of an unexpected failure, as a person may read it: the database's code or the error's name, never its text. */
function failureCode(error: unknown): string {
  return errorCode(error) ?? (error instanceof Error ? error.name : "unknown");
}

/** Every lane of one workspace, pushed to `lanes` one by one so a failure later in the workspace loses none of them. */
async function convertWorkspace(
  db: Kysely<Database>,
  workspaceId: string,
  lanes: LaneReportEntry[],
  options: LaneConversionOptions,
  warn: (line: string) => void,
  progress: (line: string) => void,
): Promise<void> {
  const repositories = repositoriesOf(db, workspaceId);
  const service = createWorkflowService({
    workflows: repositories.workflows,
    projects: repositories.projects,
    environments: repositories.environments,
    profiles: repositories.profiles,
    mcpServers: repositories.mcpServers,
    mcpOAuth: repositories.mcpOAuth,
    runners: repositories.runners,
  });
  for (const lane of await repositories.workflows.list()) {
    let entry: LaneReportEntry;
    try {
      entry = await convertLane(lane, repositories, service, options, warn);
    } catch (error) {
      // One lane never stops the others: it is listed, and a run again tries it again.
      entry = {
        workspaceId,
        laneId: lane.id,
        laneName: lane.name,
        projectId: lane.projectId,
        outcome: "not_converted",
        reasons: [saveFailure(error, warn, lane.id)],
        warnings: [],
      };
    }
    lanes.push(entry);
    if (entry.outcome !== "already_inline") progress(progressLine(entry));
  }
}

/**
 * Runs the conversion. It throws only when it cannot start (an unknown `--workspace`, or the workspaces cannot be read). Once it has
 * started it always returns its report: a failure in one workspace is listed (`workspaceFailures`) and the next workspace goes on, and a
 * failure outside that ends the run early with `complete: false` and everything done up to then in the report.
 */
export async function runLaneConversion(
  options: LaneConversionOptions,
): Promise<LaneConversionReport> {
  const warn = options.warn ?? ((line: string) => console.error(line));
  const progress = options.progress ?? (() => undefined);
  const ids = await workspaceIds(options.db, options.workspaceId);
  if (options.workspaceId !== undefined && ids.length === 0)
    throw new LaneConversionError(
      "LANE_CONVERSION_WORKSPACE_NOT_FOUND",
      `There is no workspace "${options.workspaceId}" that is not deleted. Nothing was looked at.`,
    );
  const lanes: LaneReportEntry[] = [];
  const workspaceFailures: WorkspaceFailure[] = [];
  let reached = 0;
  let aborted: LaneConversionReport["aborted"];
  try {
    for (const workspaceId of ids) {
      reached += 1;
      try {
        await convertWorkspace(
          options.db,
          workspaceId,
          lanes,
          options,
          warn,
          progress,
        );
      } catch (error) {
        const code = failureCode(error);
        warn(`[lanes:convert] workspace ${workspaceId}: failed (${code})`);
        workspaceFailures.push({
          workspaceId,
          code,
          message:
            "The workspace could not be read or finished, so lanes of it may not have been looked at. See the log; run it again.",
        });
      }
    }
  } catch (error) {
    aborted = {
      code: failureCode(error),
      message: `The run ended early: ${String(ids.length - reached)} workspace(s) were not reached and the workspace being worked on may be half done (each lane is saved whole or not at all). Run it again.`,
    };
  }
  const counts = Object.fromEntries(
    LANE_OUTCOMES.map((outcome) => [
      outcome,
      lanes.filter((lane) => lane.outcome === outcome).length,
    ]),
  ) as LaneConversionReport["counts"];
  return {
    dryRun: options.dryRun,
    scope:
      options.workspaceId === undefined
        ? { kind: "all" }
        : { kind: "workspace", workspaceId: options.workspaceId },
    complete: aborted === undefined,
    ...(aborted === undefined ? {} : { aborted }),
    workspaces: ids.length,
    workspacesReached: reached,
    workspaceFailures,
    lanes,
    notConverted: lanes.filter((lane) => lane.outcome === "not_converted"),
    archivedWithoutProject: lanes.filter(
      (lane) =>
        lane.outcome === "archived_without_project" ||
        lane.outcome === "would_archive_without_project",
    ),
    warned: lanes.filter((lane) => lane.warnings.length > 0),
    gone: lanes.filter((lane) => lane.outcome === "lane_gone"),
    counts,
  };
}
