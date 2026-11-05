// SPDX-License-Identifier: LicenseRef-Proprietary

// A member stops a run of the Implementer (#891). A run is the job of a turn; only a turn of this workspace can be named here (a
// review's job, another workspace's job and an id that does not exist all look the same: `IMPLEMENTER_RUN_NOT_FOUND`). The queue does the
// rest: a waiting turn ends at once, a running one is marked, its holder learns it from the heartbeat, stops the turn (pushing what is
// committed) and reports, and the job ends `cancelled`. Asking again, and asking for a run that is over, change nothing and say so.
import type { JobStatus } from "../db/job-status.ts";
import type { JobQueue } from "../jobs/job-queue.ts";
import { ImplementerError } from "./errors.ts";

/**
 * What the call did. `cancelled`: the turn was waiting and is over. `requested`: the turn runs and its holder is told at the next heartbeat
 * (at most 30 seconds), then stops and pushes what is committed. `already_requested`: it runs and was asked before. `already_ended`: the run
 * is over; `status` is how it ended.
 */
export const CANCEL_OUTCOMES = [
  "cancelled",
  "requested",
  "already_requested",
  "already_ended",
] as const;
export type CancelOutcome = (typeof CANCEL_OUTCOMES)[number];

export type CancelledRun = {
  runId: string;
  outcome: CancelOutcome;
  /** The status of the job now. */
  status: JobStatus;
};

export type RunCanceller = {
  /** Throws `IMPLEMENTER_RUN_NOT_FOUND` for a job that is no turn of the Implementer of this workspace. */
  cancelRun(runId: string): Promise<CancelledRun>;
};

export type RunCancellerDependencies = {
  queue: Pick<JobQueue, "get" | "requestCancel">;
  /** One line per call; never an instruction, a model or a token. */
  log?: (line: string) => void;
};

const notFound = () =>
  new ImplementerError(
    "IMPLEMENTER_RUN_NOT_FOUND",
    "There is no such run of the Implementer in this workspace.",
  );

export function createRunCanceller(
  deps: RunCancellerDependencies,
): RunCanceller {
  const log = deps.log ?? ((line) => console.info(line));
  return {
    async cancelRun(runId) {
      // The queue is scoped to the workspace: another workspace's job is not found. A review's job is not a run of the Implementer.
      const job = await deps.queue.get(runId);
      if (job?.reviewKind !== "implementer") throw notFound();
      const result = await deps.queue.requestCancel(runId);
      if (result.status === "not_found") throw notFound();
      log(
        `[implementer] cancel requested run=${runId} outcome=${result.status}`,
      );
      return { runId, outcome: result.status, status: result.job.status };
    },
  };
}
