// SPDX-License-Identifier: LicenseRef-Proprietary

// The runner side of the job queue: handing jobs to runners and finishing them. NOT scoped to a
// workspace, on purpose: runners serve the whole instance (one shared token), so a claim hands out the
// oldest due job of any workspace. What it returns carries `workspaceId`; everything the runner API
// looks up for the job afterwards goes through repositories of that workspace. Creating, dropping and
// listing jobs is scoped and lives in job-queue.ts.
import "server-only";
import type { Kysely } from "kysely";
import {
  createRunnerJobsRepository,
  type ExpiryReport,
  type ClaimOptions,
  type RunnerJobsRepositoryOptions,
} from "../db/repositories/runner-jobs-repository.ts";
import type { Database } from "../db/schema.ts";
import { JobQueueError } from "./errors.ts";
import type { RunnerEngine } from "./runner-capabilities.ts";
import type {
  CancelClaimedResult,
  ClaimResult,
  CompleteResult,
  CountFetchResult,
  HeartbeatResult,
  Job,
  JobErrorCode,
  JobOutcome,
  ReleaseOptions,
  ReleaseResult,
} from "./job-types.ts";

export type RunnerQueue = {
  /**
   * Gives the runner the oldest due job its engines can run, with the lease token of the claim, or
   * null. `engines` (#195) is what the runner advertised; a previous-release caller sends none and
   * is `pr-agent` only. An unsupported job is never selected: it waits, no attempt is counted and no
   * credential is created. First puts jobs whose lease ran out back in the queue (or fails them after
   * the last attempt, or on timeout), so nothing else has to watch the clock. At most one job per
   * pull request is running at any time.
   */
  claimNext(
    runnerId: string,
    engines?: readonly RunnerEngine[],
    claimOptions?: ClaimOptions,
  ): Promise<ClaimResult>;
  /**
   * #320: the job a lease token was issued for, whatever its status (the claim that runs or the one
   * that ended); `undefined` for any other token. The Worker API's way to tell "not your credential"
   * from "the job ended".
   */
  holding(jobId: string, leaseToken: string): Promise<Job | undefined>;
  /** #320: counts one fetch of the job details of the running claim, up to `limit` per claim. */
  countFetch(
    jobId: string,
    leaseToken: string,
    limit: number,
  ): Promise<CountFetchResult>;
  /**
   * Extends the lease of the claim the token belongs to; `not_holder` for any other token (a stale
   * execution of the same job counts, even under the same runner id) and for a job past the hard
   * limit, which this call fails with `timeout`.
   */
  heartbeat(jobId: string, leaseToken: string): Promise<HeartbeatResult>;
  /** Finishes the claim; reporting the same outcome again answers `already_completed`. */
  complete(
    jobId: string,
    leaseToken: string,
    outcome: JobOutcome,
  ): Promise<CompleteResult>;
  /**
   * Gives a claimed job back (for example the runner shuts down, or the token for the repository
   * could not be created). It counts as a lost attempt with the same cap as a lapsed lease: the job
   * waits again, from `retryAt` if given, or fails with `reason` on the last allowed attempt.
   */
  release(
    jobId: string,
    leaseToken: string,
    reason: string,
    options?: ReleaseOptions,
  ): Promise<ReleaseResult>;
  /**
   * Cancels a claimed job (the project of its repository is off): running -> cancelled with
   * `errorCode`, in one statement fenced by the lease token. No attempt is counted, so the job ends
   * `cancelled` also on its last allowed attempt, and it is never queued again in between.
   */
  cancelClaimed(
    jobId: string,
    leaseToken: string,
    errorCode: JobErrorCode,
  ): Promise<CancelClaimedResult>;
  /**
   * #397: the holder of the running claim understands that its run can be superseded (the Worker's job details
   * request named the feature `supersede`; a runner names it in its claim). False for any other token or a job that
   * is not running.
   */
  noteSupersede(jobId: string, leaseToken: string): Promise<boolean>;
  /** A job by its id, whatever its workspace. */
  get(id: string): Promise<Job | undefined>;
  /** The expiry step of `claimNext` on its own. */
  expireStaleJobs(): Promise<ExpiryReport>;
  /**
   * #328: fails the queued jobs that waited `waitedMs` or longer for a claim with `dispatch_unavailable`
   * (the cron sweep of a hosted deployment, when no Dispatcher took them). Returns how many.
   */
  failUndispatched(waitedMs: number): Promise<number>;
  /** #328: how many jobs are running now, whoever claimed them. */
  countRunning(): Promise<number>;
};

export function createRunnerQueue(
  db: Kysely<Database>,
  options: RunnerJobsRepositoryOptions = {},
): RunnerQueue {
  const jobs = createRunnerJobsRepository(db, options);

  return {
    claimNext: (runnerId, engines, claimOptions) =>
      jobs.claimNext(runnerId, engines, claimOptions),
    holding: (jobId, leaseToken) => jobs.holding(jobId, leaseToken),
    countFetch: (jobId, leaseToken, limit) =>
      jobs.countFetch(jobId, leaseToken, limit),
    heartbeat: (jobId, leaseToken) => jobs.heartbeat(jobId, leaseToken),
    complete: (jobId, leaseToken, outcome) =>
      jobs.complete(jobId, leaseToken, outcome),
    async release(jobId, leaseToken, reason, releaseOptions) {
      if (reason.trim() === "")
        throw new JobQueueError(
          "JOB_INPUT_INVALID",
          "The reason is not valid: reason (required).",
          { fieldErrors: [{ field: "reason", code: "required" }] },
        );
      return jobs.release(jobId, leaseToken, reason, releaseOptions);
    },
    noteSupersede: (jobId, leaseToken) => jobs.noteSupersede(jobId, leaseToken),
    get: (id) => jobs.get(id),
    expireStaleJobs: () => jobs.expireStaleJobs(),
    failUndispatched: (waitedMs) => jobs.failUndispatched(waitedMs),
    countRunning: () => jobs.countRunning(),
    cancelClaimed: (jobId, leaseToken, errorCode) =>
      jobs.cancelClaimed(jobId, leaseToken, errorCode),
  };
}
