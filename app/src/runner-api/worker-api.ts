// SPDX-License-Identifier: LicenseRef-Proprietary

// The Worker API (#320, `/api/workers/v1`): what a Worker may do with the per-job credential and nothing
// more. Three calls, all for the one job the credential was minted for:
//
//   GET  /jobs/:id             the job details, with the git token and the model key minted now (worker-fetch.ts)
//   POST /jobs/:id/heartbeat   extends the lease
//   POST /jobs/:id/result      delivers the result (the same rules as the runner API's `complete`)
//
// The order is the contract; each step ends the request on failure:
//
//   1. credential  `Authorization: Bearer crj_...`; the dispatcher credential, a lease token, a credential
//                  of another job or of an earlier claim all get the one 401 WORKER_CREDENTIAL_INVALID
//   2. job id      a UUID in the path                                                 400
//   3. body        read up to 64 KiB, JSON object, checked (result only)               413 / 400
//   4. state       the job must still be running with this claim                      409 RUNNER_JOB_ENDED
//   5. work        see the calls
//
// The credential is looked up by its hash (`workerLeaseToken`); it is never stored, never logged and
// never part of an answer. A job that ended answers 409 RUNNER_JOB_ENDED to every call but a repeat of
// its result, which is judged by the same rule as the runner API's (`finishJob`).
import "server-only";
import type { Job } from "../jobs/job-types.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import {
  bearerWorkerCredential,
  workerLeaseToken,
} from "../jobs/worker-credential.ts";
import { bodyLimitFor, discardBody, readJsonBody } from "./body.ts";
import type { ClaimDeps } from "./claim.ts";
import { describeError } from "./logger.ts";
import {
  finishJob,
  heartbeatAnswer,
  logDropped,
  RUNNER_SHUTDOWN_CODE,
  type ReportDeps,
} from "./report.ts";
import { parseJobId, parseWorkerResultRequest } from "./requests.ts";
import {
  errorResponse,
  jsonResponse,
  workerUnauthorized,
} from "./responses.ts";
import { handleFetch } from "./worker-fetch.ts";

/** The codes of a result that give the job back instead of storing it (an attempt is counted). */
export const WORKER_RELEASE_CODES = [RUNNER_SHUTDOWN_CODE, "launch_failed"];

export type WorkerApiDeps = ClaimDeps &
  ReportDeps & {
    queue: Pick<RunnerQueue, "holding" | "countFetch" | "noteSupersede">;
  };

export type WorkerApi = {
  details(request: Request, jobId: string): Promise<Response>;
  heartbeat(request: Request, jobId: string): Promise<Response>;
  result(request: Request, jobId: string): Promise<Response>;
};

/** Who is asking: the job the credential belongs to, and what the queue fences the claim on. */
type Caller =
  | { ok: true; job: Job; credential: string; leaseToken: string }
  | { ok: false; response: Response };

/** The job ended (finished, failed, cancelled): the Worker stops. */
function ended(): Response {
  return errorResponse(409, "RUNNER_JOB_ENDED");
}

/**
 * A job the app ended itself: cancelled, or failed without a result of the Worker's (the lease ran out,
 * the app ended it at fetch). Nothing the Worker reports can be stored for it.
 */
function endedByApp(job: Job): boolean {
  switch (job.status) {
    case "running":
    case "succeeded":
    // #397: a run a newer push replaced may still report (its claim is the credential's).
    case "superseded":
      return false;
    case "failed":
      return job.result === null;
    default:
      return true;
  }
}

export function createWorkerApi(deps: WorkerApiDeps): WorkerApi {
  /** Steps 1 and 2: the credential must be the one of the claim of this job. */
  async function identify(request: Request, jobId: string): Promise<Caller> {
    const credential = bearerWorkerCredential(
      request.headers.get("authorization"),
    );
    if (credential === null)
      return { ok: false, response: workerUnauthorized() };
    if (!parseJobId(jobId))
      return {
        ok: false,
        response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
          fields: [{ field: "jobId", code: "invalid" }],
        }),
      };
    const leaseToken = workerLeaseToken(credential);
    const job = await deps.queue.holding(jobId, leaseToken);
    if (job === undefined) return { ok: false, response: workerUnauthorized() };
    return { ok: true, job, credential, leaseToken };
  }

  /** A failure nobody planned for: the caller gets a generic answer, the log gets the cause. */
  function unexpected(what: string, error: unknown): Response {
    deps.logger.error(`[worker-api] ${what} failed: ${describeError(error)}`);
    return errorResponse(500, "RUNNER_INTERNAL_ERROR");
  }

  return {
    async details(request, jobId) {
      try {
        const who = await identify(request, jobId);
        if (!who.ok) return who.response;
        if (who.job.status !== "running") return ended();
        return await handleFetch(deps, {
          job: who.job,
          leaseToken: who.leaseToken,
          url: new URL(request.url),
        });
      } catch (error) {
        return unexpected("details", error);
      }
    },

    async heartbeat(request, jobId) {
      try {
        const who = await identify(request, jobId);
        if (!who.ok) return who.response;
        const refused = await discardBody(request);
        if (refused !== null) return refused;
        if (who.job.status !== "running" && who.job.status !== "superseded")
          return ended();
        const result = await deps.queue.heartbeat(jobId, who.leaseToken);
        if (result.status === "not_holder") {
          // The job ended between the check and the heartbeat (the hard time limit fails it here), or
          // the claim was lost.
          const now = await deps.queue.holding(jobId, who.leaseToken);
          deps.logger.info(`[worker-api] heartbeat job=${jobId} refused`);
          return now === undefined
            ? workerUnauthorized()
            : now.status === "running"
              ? errorResponse(409, "RUNNER_LEASE_LOST")
              : ended();
        }
        deps.activity?.();
        return jsonResponse(
          200,
          heartbeatAnswer(result.job, result.status === "superseded"),
        );
      } catch (error) {
        return unexpected("heartbeat", error);
      }
    },

    async result(request, jobId) {
      try {
        const who = await identify(request, jobId);
        if (!who.ok) return who.response;
        const body = await readJsonBody(request, bodyLimitFor(who.job));
        if (!body.ok) return body.response;
        const parsed = parseWorkerResultRequest(body.value);
        if (!parsed.ok)
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: parsed.fields,
          });
        if (endedByApp(who.job)) return ended();
        logDropped(deps, `worker result job=${jobId}`, parsed.dropped);
        return await finishJob(deps, {
          job: who.job,
          leaseToken: who.leaseToken,
          result: parsed.value.result,
          who: "worker",
          releaseCodes: WORKER_RELEASE_CODES,
          // What this Worker itself holds must not end up in its stored log either.
          extraSecrets: [who.credential],
        });
      } catch (error) {
        return unexpected("result", error);
      }
    },
  };
}
