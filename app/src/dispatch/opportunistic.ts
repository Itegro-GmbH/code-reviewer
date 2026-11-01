// SPDX-License-Identifier: LicenseRef-Proprietary

// The sweep's repair work, done by the requests that already touch the database (#395). The cron sweep runs
// every two hours only; a webhook delivery, a Worker's heartbeat or its result is a moment at which the database
// is awake anyway, so these requests (after their response) release the leases that ran out and send what is due:
// a Worker that vanished is noticed when the next request arrives, not two hours later.
//
// Cheap by construction: at most once per interval per process, and under a lock of its own (`OPPORTUNISTIC_LOCK`),
// not the sweep's: the cron runs every two hours and is not repeated by the platform, so a run of this work that held
// the sweep's lock at that moment would make the whole sweep a no-op. Everything it does is also done by the sweep;
// both are safe to repeat, and every send is fenced in its row.
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import type { TryLockResult } from "../db/try-lock.ts";
import { DEFAULT_SEND_LIMIT, type DispatchService } from "./service.ts";

/** The most often one process does it. */
export const OPPORTUNISTIC_INTERVAL_MS = 30_000;
/** A job younger than this is left to the request that queued it (its inline retries take up to 45 seconds). */
export const OPPORTUNISTIC_MIN_JOB_AGE_MS = 50_000;
/** The check runs get little time: this runs in the `after()` of a request that has a minute in all (#405). */
const CHECKS_BUDGET_MS = 15_000;

export type OpportunisticOutcome = "ran" | "throttled" | "locked" | "failed";

export type OpportunisticDependencies = {
  /** Runs the work under the try-lock of the repair work (not the sweep's). */
  withLock: <T>(work: () => Promise<T>) => Promise<TryLockResult<T>>;
  queue: Pick<RunnerQueue, "expireStaleJobs">;
  /** Absent in poll mode: nothing is sent, leases are still released. */
  dispatch?: Pick<DispatchService, "sendDue">;
  /** #405: brings the check runs of the jobs that just ended or went back to the queue in line with GitHub. */
  checks?: {
    reconcileDue(options?: { budgetMs?: number }): Promise<{ synced: number }>;
  };
  /** #790: tries again to switch off the write tokens of ended turns that could not be switched off. Left out, none is tried. */
  writeTokens?: { retryPending(): Promise<void> };
  now?: () => number;
  intervalMs?: number;
  log?: Pick<Console, "error">;
};

export type OpportunisticMaintenance = { run(): Promise<OpportunisticOutcome> };

export function createOpportunisticMaintenance(
  deps: OpportunisticDependencies,
): OpportunisticMaintenance {
  const now = deps.now ?? (() => Date.now());
  const interval = deps.intervalMs ?? OPPORTUNISTIC_INTERVAL_MS;
  const log = deps.log ?? console;
  let last = Number.NEGATIVE_INFINITY;

  return {
    async run() {
      const at = now();
      if (at - last < interval) return "throttled";
      last = at;
      try {
        const outcome = await deps.withLock(async () => {
          await deps.queue.expireStaleJobs();
          // A job queued a moment ago is still being sent by the request that queued it.
          await deps.dispatch?.sendDue(DEFAULT_SEND_LIMIT, {
            minAgeMs: OPPORTUNISTIC_MIN_JOB_AGE_MS,
          });
          // A write token the end of its turn could not switch off is tried again until it expires (#790).
          await deps.writeTokens?.retryPending();
          // The leases released above changed jobs no request named: their check runs follow.
          await deps.checks?.reconcileDue({ budgetMs: CHECKS_BUDGET_MS });
        });
        return outcome.acquired ? "ran" : "locked";
      } catch {
        // Nothing a database said is logged: a connection string can be in it.
        log.error("[dispatch] OPPORTUNISTIC_MAINTENANCE_FAILED");
        return "failed";
      }
    },
  };
}
