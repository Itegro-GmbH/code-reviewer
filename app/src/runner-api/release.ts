// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/runners/v1/jobs/:id/release: a Dispatcher gives a claimed job back because it could not
// start the Worker (#322). It proves the dispatcher credential in `Authorization` (checked by the
// caller) and the claim with the per-job credential in the body: the hash of the credential is the lease
// token the queue fences on, so another job's credential, an earlier claim's and a made-up one all
// fail the same way. The job goes back through the queue's `release`: one attempt is counted (a failed
// launch has no budget of its own), the job waits again from `retryAfterSeconds`, or fails with the
// reason on the last allowed attempt. The reasons are `launch_failed` (the Worker did not start) and
// `worker_exited` (#375: it started and its container ended with an error before it reported a result); a job that
// already has its result, or that another claim holds, is refused by the same fence and nothing changes.
import "server-only";
import type { JobEndedEvent } from "../dispatch/job-ended.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import { workerLeaseToken } from "../jobs/worker-credential.ts";
import { RUNNER_API_VERSION, type ReleaseResponse } from "./contract.ts";
import type { WriteTokenRevoker } from "./write-token.ts";
import type { RunnerApiLogger } from "./logger.ts";
import { parseReleaseRequest } from "./requests.ts";
import {
  errorResponse,
  jsonResponse,
  workerUnauthorized,
} from "./responses.ts";

export type ReleaseDeps = {
  queue: Pick<RunnerQueue, "get" | "holding" | "release">;
  logger: RunnerApiLogger;
  now: () => Date;
  /** #395: the job went back to the queue (or failed on its last attempt); see `ReportDeps.jobEnded`. */
  jobEnded?: (event: JobEndedEvent) => void;
  /** #753: switches off the write tokens of a turn of the Implementer that was given back (a Worker that ended without a result). */
  revokeWriteTokens?: WriteTokenRevoker;
};

/** The reason a job fails with when a Dispatcher gives it back; a reason the app does not know becomes this one. */
export const LAUNCH_FAILED_CODE = "launch_failed";
/** #375: the Worker's container ended with an error before it reported a result. */
export const WORKER_EXITED_CODE = "worker_exited";
const KNOWN_RELEASE_REASONS: readonly string[] = [
  LAUNCH_FAILED_CODE,
  WORKER_EXITED_CODE,
];

export async function handleRelease(
  deps: ReleaseDeps,
  jobId: string,
  runnerId: string,
  body: unknown,
): Promise<Response> {
  const parsed = parseReleaseRequest(body);
  if (!parsed.ok)
    return errorResponse(400, "RUNNER_REQUEST_INVALID", {
      fields: parsed.fields,
    });
  if ((await deps.queue.get(jobId)) === undefined)
    return errorResponse(404, "RUNNER_JOB_NOT_FOUND");

  const { credential, retryAfterSeconds } = parsed.value;
  const leaseToken = workerLeaseToken(credential);
  // The error code is stored on a job that fails, and the UI has copy for the codes it knows: a reason of
  // a Dispatcher that is not one of them (a newer one) is stored as the general `launch_failed`.
  const code = KNOWN_RELEASE_REASONS.includes(parsed.value.reason)
    ? parsed.value.reason
    : LAUNCH_FAILED_CODE;
  const released = await deps.queue.release(
    jobId,
    leaseToken,
    code,
    retryAfterSeconds === undefined
      ? undefined
      : { retryAt: new Date(deps.now().getTime() + retryAfterSeconds * 1000) },
  );
  if (released.status === "not_holder") {
    // A credential that is not the claim's is 401; the claim of that credential having ended is 409.
    const held = await deps.queue.holding(jobId, leaseToken);
    deps.logger.info(
      `[runner-api] release runner=${runnerId} job=${jobId} refused: ${held === undefined ? "credential" : "ended"}`,
    );
    return held === undefined
      ? workerUnauthorized()
      : errorResponse(409, "RUNNER_JOB_ENDED");
  }
  if (released.status === "cancelled")
    return errorResponse(409, "RUNNER_JOB_ENDED");
  deps.logger.info(
    `[runner-api] release runner=${runnerId} job=${jobId} reason=${parsed.value.reason} (${released.status})`,
  );
  deps.jobEnded?.({
    jobId: released.job.id,
    repositoryId: released.job.repositoryId,
    prNumber: released.job.prNumber,
    requeued: released.status === "requeued",
  });
  await deps.revokeWriteTokens?.(released.job);
  return jsonResponse(200, {
    version: RUNNER_API_VERSION,
    job: {
      id: released.job.id,
      status: released.status === "requeued" ? "queued" : "failed",
    },
  } satisfies ReleaseResponse);
}
