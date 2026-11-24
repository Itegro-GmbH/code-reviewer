// SPDX-License-Identifier: LicenseRef-Proprietary

// The schedule trigger (#1140): a lane whose current version has a trigger `{ kind: "schedule", cron }` starts a run at its cron time. The
// platform's cron calls `GET /api/internal/schedule-runs` once an hour (`vercel.json`; `src/cron/schedule-runs.ts`), and this is what that
// tick does: it walks the workspaces that have such a lane, and per workspace every lane, through that workspace's own repositories.
//
//  - UTC, and tick precision. The expression is read in UTC. A schedule fires at the first hourly tick at or after its time, so a lane
//    with `30 6 * * 0` starts at the 07:00 tick; minute precision is not given.
//  - One occurrence per tick, at most. The due occurrence of a trigger is the LATEST time its expression names that is not after the tick,
//    not older than `SCHEDULE_CATCH_UP_MS` (24 hours) and not before the version of the lane was saved (`dueOccurrence`). A missed tick
//    is made up by the next one (the window is longer than the tick), only the most recent occurrence, and an occurrence older than the
//    window is dropped: a week the app was down is never back-filled. A lane saved after an occurrence does not start for it (saving a
//    lane at 09:00 must not start the 06:00 run of that morning).
//  - Exactly once. The run's request id is made of the lane, the trigger and the occurrence (`scheduleRequestId`), and a request id is
//    unique in the workspace, so a retried or overlapping tick, and the later ticks that still see the same occurrence, find the run that
//    exists and write none. The database holds it, no lock is needed.
//  - Busy. A lane has at most one running run per schedule trigger (the trigger key `schedule:<trigger id>`, the rule of the label and
//    status triggers): while the scheduled run of an earlier occurrence still goes on (it may wait for an answer), the new occurrence
//    starts nothing (`busy`) and the next ticks try again until the window ends. Runs started by hand or by another trigger are not
//    counted.
//  - Who runs it. Like every run a trigger starts, it has no `created_by`: the engine runs its turns for the author of the lane version
//    the run uses, and refuses the run (`workflow_owner_gone`) when that person has left the workspace. The run shows `schedule` and
//    the trigger's id; the login it shows is `schedule`. Nobody's login is made up.
//  - The work. A scheduled run has no ticket and no input: it works on the repository of the lane's project and its default branch, as a
//    run by hand of a trigger without `input` does. A lane without a project, with a switched-off project, or whose repository is not
//    available starts nothing (`skipped`, with a code in the log).
//  - One lane's failure never stops the others: each lane, and each workspace, is tried on its own; the log names the workspace or the
//    lane by its id and the code of its failure, never the cause (a database error may carry a connection string).
import type {
  RunTriggerKind,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import type {
  StoredWorkflow,
  StoredWorkflowVersion,
} from "../db/repositories/workflows-repository.ts";
import { BUDGET_OPERATOR_MAX_USD } from "../workflows/limits.ts";
import { latestOccurrence, parseCron } from "../workflows/cron.ts";
import {
  forTrigger,
  readRunDocument,
  runBudgetMicroUsd,
  unsupportedStep,
} from "./document.ts";
import { bounded } from "./ticket.ts";
import { BRANCH_MAX_CHARS } from "./limits.ts";

/** What a run a schedule started is recorded as. */
export const SCHEDULE_TRIGGER_KIND = "schedule" satisfies RunTriggerKind;

/** The login a scheduled run shows: no person started it. */
export const SCHEDULE_ACTOR_LOGIN = "schedule";

/**
 * How long after its time an occurrence may still be started: a missed tick is made up, a longer outage is not. Longer than the tick (one
 * hour) so one lost tick costs nothing, and short enough that nothing from weeks ago starts.
 */
export const SCHEDULE_CATCH_UP_MS = 24 * 60 * 60 * 1000;

export const SCHEDULE_ERROR_CODES = [
  "SCHEDULE_DOCUMENT_UNUSABLE",
  "SCHEDULE_STEP_NOT_SUPPORTED",
  "SCHEDULE_PROJECT_UNAVAILABLE",
  "SCHEDULE_REPOSITORY_UNAVAILABLE",
  "SCHEDULE_START_FAILED",
  "SCHEDULE_WORKSPACE_FAILED",
] as const;
export type ScheduleErrorCode = (typeof SCHEDULE_ERROR_CODES)[number];

const MINUTE_MS = 60_000;

/**
 * The occurrence of `cron` a tick at `now` starts, or undefined: the latest minute the expression names that lies in the window
 * (`now` minus `SCHEDULE_CATCH_UP_MS`, exclusive, up to `now`) and is not before `versionSavedAt`.
 */
export function dueOccurrence(
  cron: string,
  now: Date,
  versionSavedAt: Date,
): Date | undefined {
  const schedule = parseCron(cron);
  if (schedule === undefined) return undefined;
  const minute = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const windowStart = minute - SCHEDULE_CATCH_UP_MS + MINUTE_MS;
  const savedAt = versionSavedAt.getTime();
  return latestOccurrence(schedule, {
    atOrBefore: now,
    notBefore: new Date(
      Number.isFinite(savedAt) ? Math.max(windowStart, savedAt) : windowStart,
    ),
  });
}

/** The request id a schedule starts a run under: the lane, the trigger and the occurrence (to the minute, UTC) decide it, nothing else. */
export function scheduleRequestId(
  workflowId: string,
  triggerId: string,
  occurrence: Date,
): string {
  const minute = occurrence.toISOString().slice(0, 16).replaceAll(/[-:T]/g, "");
  return `sched-${workflowId}-${triggerId}-${minute}`;
}

/** The trigger key of a schedule trigger: the lane has at most one running run for it. */
export const scheduleTriggerKey = (triggerId: string): string =>
  `schedule:${triggerId}`;

/** What one workspace's lanes need; made per workspace, over repositories created for that workspace. */
export type ScheduleWorkspaceDependencies = {
  /** The lanes of the workspace, not archived, in an active project, whose current version names a schedule trigger (a text match; this reads the document). */
  workflows: {
    listWithScheduleTrigger(): Promise<
      { workflow: StoredWorkflow; current: StoredWorkflowVersion }[]
    >;
  };
  runs: Pick<WorkflowRunsRepository, "createRun">;
  /** The project of a lane; undefined when it is gone. */
  projectOf(
    projectId: string,
  ): Promise<{ active: boolean; repositoryId: string } | undefined>;
  /** The repository when it is an active one of the workspace, with its default branch; undefined otherwise. May throw when the platform cannot be asked. */
  repositoryOf(
    repositoryId: string,
  ): Promise<
    { id: string; fullName: string; defaultBranch: string } | undefined
  >;
  /** Tells the engine the run exists; it runs the first steps after the response. Never throws. */
  kick(runId: string): void;
  /** The most a workflow may be given to spend: `BUDGET_OPERATOR_MAX_USD`. */
  maxBudgetUsd?: number;
};

export type ScheduleRunnerDependencies = {
  /** The workspaces that have a lane with a schedule trigger (instance level: only ids). */
  workspaces(): Promise<string[]>;
  forWorkspace(workspaceId: string): ScheduleWorkspaceDependencies;
  now?: () => Date;
  /** One line per lane or workspace left out or failed; never a value of the lane's document or a cause. */
  log?: (line: string) => void;
};

/** What one tick made of the lanes. Counts of runs and of lanes; no names. */
export type ScheduleTickResult = {
  workspaces: number;
  lanes: number;
  /** The runs this tick wrote. */
  started: number;
  /** The runs an earlier tick, or a call that overlapped, had written. */
  existing: number;
  /** Occurrences that start nothing now because the earlier scheduled run of the lane still goes on. */
  busy: number;
  /** Lanes with no occurrence due. */
  notDue: number;
  /** Due occurrences that start nothing (a lane the engine cannot run, no project, no repository). */
  skipped: number;
  /** Lanes and workspaces that could not be tried; see the log for the codes. */
  failed: number;
};

export type ScheduleRunner = { run(): Promise<ScheduleTickResult> };

function failureName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

export function createScheduleRunner(
  deps: ScheduleRunnerDependencies,
): ScheduleRunner {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line) => console.error(line));

  async function runWorkspace(
    workspaceId: string,
    tick: Date,
    result: ScheduleTickResult,
  ): Promise<void> {
    const workspace = deps.forWorkspace(workspaceId);
    const maxBudgetUsd = workspace.maxBudgetUsd ?? BUDGET_OPERATOR_MAX_USD;
    const lanes = await workspace.workflows.listWithScheduleTrigger();
    for (const { workflow, current } of lanes) {
      result.lanes += 1;
      const where = `workspace=${workspaceId} workflow=${workflow.id}`;
      const skip = (code: ScheduleErrorCode, count: number): void => {
        result.skipped += count;
        log(`[schedule] ${code}: ${where} starts no run.`);
      };
      try {
        const read = readRunDocument(current.document);
        if (read === undefined) {
          skip("SCHEDULE_DOCUMENT_UNUSABLE", 1);
          continue;
        }
        const savedAt = new Date(current.createdAt);
        const due = read.triggers
          .filter((trigger) => trigger.kind === SCHEDULE_TRIGGER_KIND)
          .flatMap((trigger) => {
            const occurrence = dueOccurrence(trigger.cron ?? "", tick, savedAt);
            return occurrence === undefined ? [] : [{ trigger, occurrence }];
          });
        if (due.length === 0) {
          result.notDue += 1;
          continue;
        }
        // The platform is asked (the repository's default branch) only once something is due.
        const project =
          workflow.projectId === null
            ? undefined
            : await workspace.projectOf(workflow.projectId);
        if (project === undefined || !project.active) {
          skip("SCHEDULE_PROJECT_UNAVAILABLE", due.length);
          continue;
        }
        const repository = await workspace.repositoryOf(project.repositoryId);
        if (repository === undefined) {
          skip("SCHEDULE_REPOSITORY_UNAVAILABLE", due.length);
          continue;
        }
        for (const { trigger, occurrence } of due) {
          const document = forTrigger(read, {
            id: trigger.id,
            kind: trigger.kind,
          });
          if (document === undefined) {
            skip("SCHEDULE_DOCUMENT_UNUSABLE", 1);
            continue;
          }
          if (unsupportedStep(document) !== undefined) {
            skip("SCHEDULE_STEP_NOT_SUPPORTED", 1);
            continue;
          }
          try {
            const created = await workspace.runs.createRun({
              workflowId: workflow.id,
              workflowVersion: current.version,
              repositoryId: repository.id,
              baseBranch: bounded(
                repository.defaultBranch,
                BRANCH_MAX_CHARS,
                false,
              ),
              triggerInput: "{}",
              budgetMicroUsd: runBudgetMicroUsd(document, maxBudgetUsd),
              clientRequestId: scheduleRequestId(
                workflow.id,
                trigger.id,
                occurrence,
              ),
              triggerKind: SCHEDULE_TRIGGER_KIND,
              triggerId: trigger.id,
              triggerKey: scheduleTriggerKey(trigger.id),
              createdBy: null,
              actorLogin: SCHEDULE_ACTOR_LOGIN,
            });
            if (created.status === "busy") {
              result.busy += 1;
              log(
                `[schedule] ${where} trigger=${trigger.id.slice(0, 64)} starts no run: run=${created.run.id} of an earlier occurrence still goes on.`,
              );
              continue;
            }
            if (created.status === "created") result.started += 1;
            else result.existing += 1;
            // A run an earlier try wrote may have lost its first push (the process ended between the write and the kick): `advance`
            // does nothing for a run that is moving, and takes it on where it stopped otherwise.
            if (
              created.status === "created" ||
              created.run.status === "running"
            )
              workspace.kick(created.run.id);
          } catch (error) {
            result.failed += 1;
            log(
              `[schedule] SCHEDULE_START_FAILED: ${where} trigger=${trigger.id.slice(0, 64)} (${failureName(error)}); the others go on.`,
            );
          }
        }
      } catch (error) {
        result.failed += 1;
        log(
          `[schedule] SCHEDULE_START_FAILED: ${where} (${failureName(error)}); the others go on.`,
        );
      }
    }
  }

  return {
    async run() {
      const tick = now();
      const result: ScheduleTickResult = {
        workspaces: 0,
        lanes: 0,
        started: 0,
        existing: 0,
        busy: 0,
        notDue: 0,
        skipped: 0,
        failed: 0,
      };
      const workspaces = await deps.workspaces();
      result.workspaces = workspaces.length;
      for (const workspaceId of workspaces) {
        try {
          await runWorkspace(workspaceId, tick, result);
        } catch (error) {
          result.failed += 1;
          log(
            `[schedule] SCHEDULE_WORKSPACE_FAILED: workspace=${workspaceId} (${failureName(error)}); the others go on.`,
          );
        }
      }
      log(
        `[schedule] tick ${tick.toISOString()} done: ${String(result.workspaces)} workspaces, ${String(result.lanes)} lanes, ${String(result.started)} started, ${String(result.existing)} existing, ${String(result.busy)} busy, ${String(result.notDue)} not due, ${String(result.skipped)} skipped, ${String(result.failed)} failed`,
      );
      return result;
    },
  };
}
