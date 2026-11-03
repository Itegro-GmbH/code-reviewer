// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/runners/v1/jobs/:id/vm: the Dispatcher says that it created the VM of a claim (#493, src/billing/README.md,
// "Billable minutes"). It proves the dispatcher credential in `Authorization` (checked by the caller) and the claim with
// the per-job credential in the body, like the release: the Worker, which holds only the per-job credential, has no way
// to call it, and a stranger's, an earlier claim's and a made-up credential all fail the same way. The first report of
// a VM wins; a report after the claim ended is refused (the backstop covers that VM). It only measures: no price, no
// journal entry, and nothing that could delay or fail the launch.
import "server-only";
import type { JobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import { workerLeaseToken } from "../jobs/worker-credential.ts";
import { RUNNER_API_VERSION, type VmStartResponse } from "./contract.ts";
import type { RunnerApiLogger } from "./logger.ts";
import { parseVmStartRequest } from "./requests.ts";
import {
  errorResponse,
  jsonResponse,
  workerUnauthorized,
} from "./responses.ts";

export type VmStartDeps = {
  queue: Pick<RunnerQueue, "get" | "holding">;
  /** The VM runs of a job's workspace; scoped, like every repository of customer data. */
  vmRuns: (workspaceId: string) => JobVmRunsRepository;
  logger: RunnerApiLogger;
};

export async function handleVmStart(
  deps: VmStartDeps,
  jobId: string,
  runnerId: string,
  body: unknown,
): Promise<Response> {
  const parsed = parseVmStartRequest(body);
  if (!parsed.ok)
    return errorResponse(400, "RUNNER_REQUEST_INVALID", {
      fields: parsed.fields,
    });
  if ((await deps.queue.get(jobId)) === undefined)
    return errorResponse(404, "RUNNER_JOB_NOT_FOUND");

  const { credential, vmName, startedAt, timeoutSeconds, vcpus } = parsed.value;
  const job = await deps.queue.holding(jobId, workerLeaseToken(credential));
  // A credential that is not a claim of the job is 401; the claim of that credential having ended is 409.
  if (job === undefined) return workerUnauthorized();
  if (job.status !== "running" || job.claimedAt === null) {
    deps.logger.info(
      `[runner-api] vm runner=${runnerId} job=${jobId} refused: ended`,
    );
    return errorResponse(409, "RUNNER_JOB_ENDED");
  }
  const result = await deps.vmRuns(job.workspaceId).recordStart({
    jobId,
    vmName,
    claimedAt: job.claimedAt,
    attempt: job.attempts + 1,
    startedAt: new Date(startedAt),
    vmTimeoutSeconds: timeoutSeconds,
    ...(vcpus === undefined ? {} : { vcpus }),
  });
  if (result === "refused") {
    deps.logger.info(
      `[runner-api] vm runner=${runnerId} job=${jobId} refused: ended`,
    );
    return errorResponse(409, "RUNNER_JOB_ENDED");
  }
  deps.logger.info(`[runner-api] vm runner=${runnerId} job=${jobId} ${result}`);
  return jsonResponse(200, {
    version: RUNNER_API_VERSION,
    status: result,
  } satisfies VmStartResponse);
}
