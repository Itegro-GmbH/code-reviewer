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
import { WorkflowError } from "../workflows/errors.ts";
import { createWorkflowService } from "../workflows/service.ts";
import { CONVERSION_CHANGE_DESCRIPTION, convertDocument } from "./convert.ts";
import {
  LANE_OUTCOMES,
  type ConversionReason,
  type ConversionWorld,
  type EnvironmentValues,
  type LaneConversionReport,
  type LaneOutcome,
  type LaneReportEntry,
  type ProfileLookup,
} from "./types.ts";

export type LaneConversionOptions = {
  db: Kysely<Database>;
  /** Report only: nothing is saved or archived. */
  dryRun: boolean;
  /** Only this workspace. Left out: every workspace that is not deleted. */
  workspaceId?: string;
  /** Where an unexpected failure of one lane is noted (its database error code, never its text). Left out: `console.error`. */
  warn?: (line: string) => void;
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

/** What the conversion asks of one workspace's data, read through the repositories the app itself uses. */
async function worldOf(
  db: Kysely<Database>,
  workspaceId: string,
): Promise<{
  world: ConversionWorld;
  repositories: ReturnType<typeof repositoriesOf>;
}> {
  const repositories = repositoriesOf(db, workspaceId);
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
  return { world, repositories };
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

async function convertLane(
  lane: StoredWorkflow,
  world: ConversionWorld,
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
    ...rest,
  });
  if (lane.projectId === null) {
    if (options.dryRun) return entry("would_archive_without_project");
    await repositories.workflows.archive(lane.id, NO_ARCHIVE_LIMIT);
    return entry("archived_without_project");
  }
  const found = await repositories.workflows.get(lane.id);
  if (found === undefined) return entry("already_inline");
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
  const converted = await convertDocument(stored, world);
  if (converted.reasons.length > 0)
    return entry("not_converted", { reasons: converted.reasons });
  if (converted.document === undefined) return entry("already_inline");

  // The same validator a save uses, with the runner rules at the step's runner. Any issue: no version.
  const checked = await service.validate(converted.document);
  if (!checked.valid)
    return entry("not_converted", {
      reasons: [validationReason(checked.errors)],
    });
  if (options.dryRun)
    return entry("would_convert", {
      version: current.version + 1,
      steps: converted.steps,
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
    });
  } catch (error) {
    return entry("not_converted", {
      reasons: [saveFailure(error, warn, lane.id)],
    });
  }
}

export async function runLaneConversion(
  options: LaneConversionOptions,
): Promise<LaneConversionReport> {
  const warn = options.warn ?? ((line: string) => console.error(line));
  const ids = await workspaceIds(options.db, options.workspaceId);
  const lanes: LaneReportEntry[] = [];
  for (const workspaceId of ids) {
    const { world, repositories } = await worldOf(options.db, workspaceId);
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
      try {
        lanes.push(
          await convertLane(lane, world, repositories, service, options, warn),
        );
      } catch (error) {
        // One lane never stops the others: it is listed, and a run again tries it again.
        lanes.push({
          workspaceId,
          laneId: lane.id,
          laneName: lane.name,
          projectId: lane.projectId,
          outcome: "not_converted",
          reasons: [saveFailure(error, warn, lane.id)],
        });
      }
    }
  }
  const counts = Object.fromEntries(
    LANE_OUTCOMES.map((outcome) => [
      outcome,
      lanes.filter((lane) => lane.outcome === outcome).length,
    ]),
  ) as LaneConversionReport["counts"];
  return {
    dryRun: options.dryRun,
    workspaces: ids.length,
    lanes,
    notConverted: lanes.filter((lane) => lane.outcome === "not_converted"),
    archivedWithoutProject: lanes.filter(
      (lane) =>
        lane.outcome === "archived_without_project" ||
        lane.outcome === "would_archive_without_project",
    ),
    counts,
  };
}
