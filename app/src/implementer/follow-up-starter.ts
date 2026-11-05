// SPDX-License-Identifier: LicenseRef-Proprietary

// Starts the instructions that waited for the end of a turn (#841). It is called after a claim ended (the report of a turn, a stop, a
// cancel, a lapsed lease) and by the cron sweep; both do the same thing: look for the idle sessions that hold a queued instruction
// and start each one. That makes the hook idempotent (a second call finds nothing, and the start itself takes the session's row lock
// and requires `idle` and a queued instruction), and an event that was lost is found by the next sweep.
//
// It never throws: a failure of one session is counted and logged by a stable word, and the others go on. It cannot fail the end of a
// turn, which has been committed before it runs.
import type { DueFollowUp } from "../db/repositories/implementer-sessions-sweep.ts";
import type { StartQueuedOutcome } from "./follow-up.ts";

/** At most this many sessions are looked at in one run; the sweep runs every minute. */
export const DUE_FOLLOW_UP_LIMIT = 20;

export type FollowUpRunReport = {
  started: number;
  discarded: number;
  /** The platform could not be asked: the instruction stays queued. */
  retry: number;
  /** An unexpected failure while starting. */
  failed: number;
};

export type QueuedFollowUpStarterDependencies = {
  due(limit: number): Promise<DueFollowUp[]>;
  start(workspaceId: string, sessionId: string): Promise<StartQueuedOutcome>;
  log?: Pick<Console, "info" | "error">;
};

export type QueuedFollowUpStarter = {
  startDue(): Promise<FollowUpRunReport>;
};

export function createQueuedFollowUpStarter(
  deps: QueuedFollowUpStarterDependencies,
): QueuedFollowUpStarter {
  const log = deps.log ?? console;
  return {
    async startDue() {
      const report: FollowUpRunReport = {
        started: 0,
        discarded: 0,
        retry: 0,
        failed: 0,
      };
      let due: DueFollowUp[];
      try {
        due = await deps.due(DUE_FOLLOW_UP_LIMIT);
      } catch {
        log.error("[implementer] FOLLOW_UP_LOOKUP_FAILED");
        report.failed += 1;
        return report;
      }
      for (const { workspaceId, sessionId } of due) {
        try {
          const outcome = await deps.start(workspaceId, sessionId);
          if (outcome.status === "started") report.started += 1;
          else if (outcome.status === "discarded") report.discarded += 1;
          else if (outcome.status === "retry") report.retry += 1;
        } catch {
          // Nothing the database or the platform said is logged: a connection string can be in it.
          log.error(
            `[implementer] FOLLOW_UP_START_FAILED session=${sessionId}`,
          );
          report.failed += 1;
        }
      }
      return report;
    },
  };
}
