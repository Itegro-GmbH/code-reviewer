// SPDX-License-Identifier: LicenseRef-Proprietary

// Starts the instructions that waited for the end of a turn (#841). Two callers, two scopes:
//  - the hook after a claim ended (the report of a turn, a stop, a cancel, a lapsed lease) starts the session of THAT turn
//    (`startForJob`), so one event costs at most one start, whatever else is queued;
//  - the cron sweep (`startDue`) looks for the idle sessions that hold a queued instruction and starts each one: the ones an event
//    did not reach. A session it has tried within `FOLLOW_UP_RETRY_BACKOFF_MS` is left for later, and the ones never tried or tried
//    longest ago come first, so a session the platform keeps refusing does not crowd out the newer ones.
// Both are idempotent (the start takes the session's row lock and requires `idle` and a queued instruction), and an event that was
// lost is found by the next sweep.
//
// It never throws: a failure of one session is counted and logged by a stable word, and the others go on. It cannot fail the end of a
// turn, which has been committed before it runs.
import type { DueFollowUp } from "../db/repositories/implementer-sessions-sweep.ts";
import type { StartQueuedOutcome } from "./follow-up.ts";

/** At most this many sessions are looked at in one run; the sweep runs every minute. */
export const DUE_FOLLOW_UP_LIMIT = 20;

/** A session whose start was tried is not tried again by the sweep for this long (GitHub may be rate limiting or down). */
export const FOLLOW_UP_RETRY_BACKOFF_MS = 5 * 60 * 1000;

export type FollowUpRunReport = {
  started: number;
  discarded: number;
  /** The platform could not be asked: the instruction stays queued. */
  retry: number;
  /** An unexpected failure while starting. */
  failed: number;
};

export type QueuedFollowUpStarterDependencies = {
  /** The sessions to try, never tried first; `retryAfter` (ISO 8601) is the latest try time that still counts as "tried recently". */
  due(limit: number, retryAfter: string): Promise<DueFollowUp[]>;
  /** The session that ran the job; undefined for a job that is no turn of a session. */
  sessionOfJob(workspaceId: string, jobId: string): Promise<string | undefined>;
  start(workspaceId: string, sessionId: string): Promise<StartQueuedOutcome>;
  now?: () => Date;
  log?: Pick<Console, "info" | "error">;
};

export type QueuedFollowUpStarter = {
  /** The sweep: the sessions that hold an instruction and were not tried lately. */
  startDue(): Promise<FollowUpRunReport>;
  /** The hook: the instruction behind the turn that this job was, if any. */
  startForJob(job: {
    id: string;
    workspaceId: string;
  }): Promise<FollowUpRunReport>;
};

export function createQueuedFollowUpStarter(
  deps: QueuedFollowUpStarterDependencies,
): QueuedFollowUpStarter {
  const log = deps.log ?? console;
  const now = deps.now ?? (() => new Date());

  const emptyReport = (): FollowUpRunReport => ({
    started: 0,
    discarded: 0,
    retry: 0,
    failed: 0,
  });

  async function startEach(
    sessions: readonly DueFollowUp[],
    report: FollowUpRunReport,
  ): Promise<FollowUpRunReport> {
    for (const { workspaceId, sessionId } of sessions) {
      try {
        const outcome = await deps.start(workspaceId, sessionId);
        if (outcome.status === "started") report.started += 1;
        else if (outcome.status === "discarded") report.discarded += 1;
        else if (outcome.status === "retry") report.retry += 1;
      } catch {
        // Nothing the database or the platform said is logged: a connection string can be in it.
        log.error(`[implementer] FOLLOW_UP_START_FAILED session=${sessionId}`);
        report.failed += 1;
      }
    }
    return report;
  }

  return {
    async startDue() {
      const report = emptyReport();
      let due: DueFollowUp[];
      try {
        due = await deps.due(
          DUE_FOLLOW_UP_LIMIT,
          new Date(now().getTime() - FOLLOW_UP_RETRY_BACKOFF_MS).toISOString(),
        );
      } catch {
        log.error("[implementer] FOLLOW_UP_LOOKUP_FAILED");
        report.failed += 1;
        return report;
      }
      return startEach(due, report);
    },

    async startForJob(job) {
      const report = emptyReport();
      let sessionId: string | undefined;
      try {
        sessionId = await deps.sessionOfJob(job.workspaceId, job.id);
      } catch {
        log.error("[implementer] FOLLOW_UP_LOOKUP_FAILED");
        report.failed += 1;
        return report;
      }
      if (sessionId === undefined) return report;
      return startEach([{ workspaceId: job.workspaceId, sessionId }], report);
    },
  };
}
