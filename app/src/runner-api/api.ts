// SPDX-License-Identifier: LicenseRef-Proprietary

// The runner API as three functions of their collaborators (`createRunnerApi`). The route files
// only call `withRunnerApi` (shared.ts); tests build the API with fakes and a real database.
//
// The order is the contract; each step ends the request on failure, and nothing in a handler before
// the token check touches the database or GitHub (building the collaborators in shared.ts only
// opens nothing; if that fails, the route answers 500 in the same form):
//
//   1. token     `Authorization: Bearer <RUNNER_TOKEN>`, constant time compare       401
//   2. runner id `X-Runner-Id`, optional, for bookkeeping only                       400
//   3. job id    a UUID in the path (heartbeat, complete, release)                            400
//   4. body      read up to 64 KiB, JSON object, checked                             413 / 400
//   5. work      claim, heartbeat or complete                                        see contract
//
// Every answer carries `Cache-Control: no-store` (responses.ts). The Worker API, which a per-job
// credential opens instead of `RUNNER_TOKEN`, is worker-api.ts.
import "server-only";
import {
  bearerWorkerCredential,
  workerLeaseToken,
} from "../jobs/worker-credential.ts";
import { DEFAULT_ENGINES } from "../jobs/runner-capabilities.ts";
import { bodyLimitFor, readJsonBody, readOptionalJsonBody } from "./body.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import { handleClaim, type ClaimDeps } from "./claim.ts";
import {
  APP_FEATURES,
  RUNNER_API_VERSION,
  SNAPSHOT_LIMITS,
  type VersionResponse,
} from "./contract.ts";
import { handleJobState, type JobStateDeps } from "./job-state.ts";
import { handleRelease, type ReleaseDeps } from "./release.ts";
import { handleVmStart, type VmStartDeps } from "./vm.ts";
import { LEASE_TOKEN_HEADER, parseLeaseTokenHeader } from "./lease-header.ts";
import { describeError } from "./logger.ts";
import { parseClaimRequest, parseJobId, parseRunnerId } from "./requests.ts";
import { handleComplete, handleHeartbeat, type ReportDeps } from "./report.ts";
import {
  errorResponse,
  jsonResponse,
  noContent,
  unauthorized,
} from "./responses.ts";
import { parseResumePart, readResumeSessionPart } from "./resume-session.ts";
import { storeSnapshotPart, type SnapshotDeps } from "./snapshot.ts";
import { parseSnapshotPartRequest } from "./snapshot-request.ts";
import { storeSteps, type StepsDeps } from "./steps.ts";
import { parseStepsRequest } from "./steps-request.ts";
import { bearerTokenOf, tokensMatch } from "./token-auth.ts";
import {
  bearerRunnerCredential,
  customerRunnerId,
  type RunnerRegistrationApi,
} from "./registration.ts";
import {
  OPENCODE_HARNESS,
  readyHarnesses,
} from "../runner-identity/harness.ts";
import type { Job } from "../jobs/job-types.ts";

export type RunnerApiDeps = ClaimDeps &
  ReportDeps &
  ReleaseDeps &
  VmStartDeps &
  StepsDeps &
  Pick<SnapshotDeps, "snapshots"> &
  JobStateDeps & {
    /** #322: the build of the app, reported by the version call. */
    appVersion: string;
    /** The configured shared secret (`RUNNER_TOKEN`), read for every request. */
    runnerToken: () => string | undefined;
    /**
     * #498: told the features of every claim that names the per-job credential (a Dispatcher's). It notes which Dispatchers the
     * app serves, so billing is not switched on over one that reports no VMs. Never throws; absent: nothing is noted.
     */
    noteClaimFeatures?: (features: readonly string[]) => Promise<void>;
    /**
     * #854: the runners of customers' own machines. A claim that carries a runner credential (`crc_...`) is theirs: it is checked
     * here and never takes the path of the shared token. Absent: the credential is not known and the claim is 401.
     */
    fleet?: Pick<RunnerRegistrationApi, "authenticate">;
  };

export type RunnerApi = {
  claim(request: Request): Promise<Response>;
  heartbeat(request: Request, jobId: string): Promise<Response>;
  complete(request: Request, jobId: string): Promise<Response>;
  /** #322: a Dispatcher gives a claimed job back. */
  release(request: Request, jobId: string): Promise<Response>;
  /** #493: a Dispatcher reports that it created the VM of a claim. */
  vmStart(request: Request, jobId: string): Promise<Response>;
  /** #745: the steps of a running turn of the Implementer (the live view); proves the claim, does not extend the lease. */
  steps(request: Request, jobId: string): Promise<Response>;
  /** #879: one part of the session snapshot of the running turn a customer's runner holds; proves the claim, does not extend the lease. */
  session(request: Request, jobId: string): Promise<Response>;
  /** #879: one part of the stored session snapshot, read by a customer's runner for a follow-up turn; proves the claim, does not extend the lease. */
  resumeSession(request: Request, jobId: string): Promise<Response>;
  /** #322: what this app is and can do. */
  version(request: Request): Promise<Response>;
  /** #364: the status of a job, for a Dispatcher that looks for the VMs of jobs that ended. */
  jobState(request: Request, jobId: string): Promise<Response>;
};

export function createRunnerApi(deps: RunnerApiDeps): RunnerApi {
  /** Steps 1 and 2: who is asking. */
  function identify(
    request: Request,
  ): { ok: true; runnerId: string } | { ok: false; response: Response } {
    const provided = bearerTokenOf(request.headers.get("authorization"));
    if (provided === null || !tokensMatch(deps.runnerToken(), provided))
      return { ok: false, response: unauthorized() };
    const runnerId = parseRunnerId(request.headers.get("x-runner-id"));
    if (!runnerId.ok)
      return {
        ok: false,
        response: errorResponse(400, "RUNNER_ID_INVALID"),
      };
    return { ok: true, runnerId: runnerId.value };
  }

  /**
   * Steps 1 to 3 for a call about one job. A customer's runner (#854) is known by its credential and may touch a job of its own
   * workspace only; the lease token in the body still proves that it holds the job. The Dispatcher's calls (the VM, the state of a job)
   * do not use this: they take the shared token alone.
   */
  async function identifyForJob(
    request: Request,
    jobId: string,
  ): Promise<
    { ok: true; runnerId: string } | { ok: false; response: Response }
  > {
    if (bearerRunnerCredential(request.headers.get("authorization")) === null)
      return identify(request);
    const customer = await deps.fleet?.authenticate(request);
    if (customer === undefined || customer === null)
      return { ok: false, response: unauthorized() };
    if (!parseJobId(jobId))
      return {
        ok: false,
        response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
          fields: [{ field: "jobId", code: "invalid" }],
        }),
      };
    const job = await deps.queue.get(jobId);
    if (job === undefined || job.workspaceId !== customer.runner.workspaceId)
      return {
        ok: false,
        response: errorResponse(404, "RUNNER_JOB_NOT_FOUND"),
      };
    return { ok: true, runnerId: customerRunnerId(customer.runner.id) };
  }

  /**
   * #879: who is asking, for the calls whose body is raw bytes (the session snapshot): a customer's runner and nobody else. The shared
   * token (a Dispatcher's) is refused here as it has the Worker API for this; so is a credential the app does not know or has revoked
   * (the same 401 for all three). The job must be of the runner's own workspace and held by this very runner (404 for any other,
   * so the answer says nothing about which): a hosted job, whose holder is a Dispatcher's id, and the job of another runner are
   * "not found". A job nobody holds any more (its lease ran out and it was put back) is let through, and the lease token then
   * decides, as it does for the steps: 409 `RUNNER_LEASE_LOST`.
   */
  async function identifyOwnedJob(
    request: Request,
    jobId: string,
  ): Promise<
    | { ok: true; runnerId: string; job: Job; leaseToken: string }
    | { ok: false; response: Response }
  > {
    const customer = await deps.fleet?.authenticate(request);
    if (customer === undefined || customer === null)
      return { ok: false, response: unauthorized() };
    if (!parseJobId(jobId))
      return {
        ok: false,
        response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
          fields: [{ field: "jobId", code: "invalid" }],
        }),
      };
    const runnerId = customerRunnerId(customer.runner.id);
    const job = await deps.queue.get(jobId);
    if (
      job === undefined ||
      job.workspaceId !== customer.runner.workspaceId ||
      (job.runnerId !== null && job.runnerId !== runnerId)
    )
      return {
        ok: false,
        response: errorResponse(404, "RUNNER_JOB_NOT_FOUND"),
      };
    const leaseToken = parseLeaseTokenHeader(
      request.headers.get(LEASE_TOKEN_HEADER),
    );
    if (!leaseToken.ok)
      return {
        ok: false,
        response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
          fields: leaseToken.fields,
        }),
      };
    return { ok: true, runnerId, job, leaseToken: leaseToken.value };
  }

  /** #322: the Worker's way into the version call: `Bearer crj_...` plus `?jobId=` of the job it holds. */
  async function isRunningClaim(request: Request): Promise<boolean> {
    const credential = bearerWorkerCredential(
      request.headers.get("authorization"),
    );
    const jobId = new URL(request.url).searchParams.get("jobId");
    if (credential === null || jobId === null || !parseJobId(jobId))
      return false;
    const job = await deps.queue.holding(jobId, workerLeaseToken(credential));
    return job?.status === "running";
  }

  /** #879: the version call of a customer's runner: a live runner's credential (a revoked or unknown one is not). */
  async function isCustomerRunner(request: Request): Promise<boolean> {
    if (bearerRunnerCredential(request.headers.get("authorization")) === null)
      return false;
    const customer = await deps.fleet?.authenticate(request);
    return customer !== undefined && customer !== null;
  }

  /** A failure nobody planned for: the caller gets a generic answer, the log gets the cause. */
  function unexpected(what: string, error: unknown): Response {
    deps.logger.error(`[runner-api] ${what} failed: ${describeError(error)}`);
    return errorResponse(500, "RUNNER_INTERNAL_ERROR");
  }

  return {
    async claim(request) {
      try {
        // #854: a customer's runner has a credential of its own; the shared token is the Dispatcher's and the poll mode's.
        if (
          bearerRunnerCredential(request.headers.get("authorization")) !== null
        ) {
          const customer = await deps.fleet?.authenticate(request);
          if (customer === undefined || customer === null)
            return unauthorized();
          // The call counts as its heartbeat (`last seen`, set by the check above). Below the minimum it gets no job.
          if (customer.updateNeeded)
            return errorResponse(426, "RUNNER_UPDATE_NEEDED", {
              ...(customer.minBaseVersion === null
                ? {}
                : { minBaseVersion: customer.minBaseVersion }),
            });
          const body = await readOptionalJsonBody(request);
          if (!body.ok) return body.response;
          const parsed = parseClaimRequest(body.value);
          if (!parsed.ok)
            return errorResponse(400, "RUNNER_REQUEST_INVALID", {
              fields: parsed.fields,
            });
          // It takes the turns of runner environments of its own workspace whose labels it has, with a harness it announces as ready
          // (OpenCode, the only harness of a profile today), and nothing else: never a review, never a split claim, never a job by id.
          if (
            !readyHarnesses(customer.runner.manifest).includes(OPENCODE_HARNESS)
          )
            return noContent();
          return await handleClaim(
            deps,
            customerRunnerId(customer.runner.id),
            ["implementer"],
            (parsed.value.features ?? []).filter(
              (feature) => feature !== "worker_credential",
            ),
            {
              ...(parsed.value.llmProviders === undefined
                ? {}
                : { llmProviders: parsed.value.llmProviders }),
              customerRunner: {
                workspaceId: customer.runner.workspaceId,
                labels: customer.runner.labels,
                // #856: the harnesses it announced as ready; a turn that asks for another is not its to take.
                harnesses: readyHarnesses(customer.runner.manifest),
              },
            },
          );
        }
        const who = identify(request);
        if (!who.ok) return who.response;
        // The claim body is read after the token check and before any job is claimed (#195).
        const body = await readOptionalJsonBody(request);
        if (!body.ok) return body.response;
        const parsed = parseClaimRequest(body.value);
        if (!parsed.ok)
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: parsed.fields,
          });
        if (parsed.value.features?.includes("worker_credential") === true)
          await deps.noteClaimFeatures?.(parsed.value.features);
        return await handleClaim(
          deps,
          who.runnerId,
          parsed.value.engines ?? DEFAULT_ENGINES,
          parsed.value.features ?? [],
          {
            ...(parsed.value.jobId === undefined
              ? {}
              : { jobId: parsed.value.jobId }),
            ...(parsed.value.maxRunning === undefined
              ? {}
              : { maxRunning: parsed.value.maxRunning }),
            ...(parsed.value.llmProviders === undefined
              ? {}
              : { llmProviders: parsed.value.llmProviders }),
          },
        );
      } catch (error) {
        return unexpected("claim", error);
      }
    },

    async heartbeat(request, jobId) {
      try {
        const who = await identifyForJob(request, jobId);
        if (!who.ok) return who.response;
        if (!parseJobId(jobId))
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: [{ field: "jobId", code: "invalid" }],
          });
        const body = await readJsonBody(request);
        if (!body.ok) return body.response;
        return await handleHeartbeat(deps, jobId, who.runnerId, body.value);
      } catch (error) {
        return unexpected("heartbeat", error);
      }
    },

    async complete(request, jobId) {
      try {
        const who = await identifyForJob(request, jobId);
        if (!who.ok) return who.response;
        if (!parseJobId(jobId))
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: [{ field: "jobId", code: "invalid" }],
          });
        // #754: a report of a turn of the Implementer may be larger (`IMPLEMENTER_MAX_BODY_BYTES`); the limit of every other kind,
        // and of a job that is not there, is the usual one. The kind is read before the body, which is read in full only up to
        // the limit of the kind.
        const known = await deps.queue.get(jobId);
        const body = await readJsonBody(request, bodyLimitFor(known));
        if (!body.ok) return body.response;
        return await handleComplete(deps, jobId, who.runnerId, body.value);
      } catch (error) {
        return unexpected("complete", error);
      }
    },

    async release(request, jobId) {
      try {
        const who = await identifyForJob(request, jobId);
        if (!who.ok) return who.response;
        if (!parseJobId(jobId))
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: [{ field: "jobId", code: "invalid" }],
          });
        const body = await readJsonBody(request);
        if (!body.ok) return body.response;
        return await handleRelease(deps, jobId, who.runnerId, body.value);
      } catch (error) {
        return unexpected("release", error);
      }
    },

    async vmStart(request, jobId) {
      try {
        const who = identify(request);
        if (!who.ok) return who.response;
        if (!parseJobId(jobId))
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: [{ field: "jobId", code: "invalid" }],
          });
        const body = await readJsonBody(request);
        if (!body.ok) return body.response;
        return await handleVmStart(deps, jobId, who.runnerId, body.value);
      } catch (error) {
        return unexpected("vm start", error);
      }
    },

    async steps(request, jobId) {
      try {
        const who = await identifyForJob(request, jobId);
        if (!who.ok) return who.response;
        if (!parseJobId(jobId))
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: [{ field: "jobId", code: "invalid" }],
          });
        const body = await readJsonBody(request);
        if (!body.ok) return body.response;
        const parsed = parseStepsRequest(body.value);
        if (!parsed.ok)
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: parsed.fields,
          });
        const job = await deps.queue.get(jobId);
        if (job === undefined)
          return errorResponse(404, "RUNNER_JOB_NOT_FOUND");
        const stored = await storeSteps(deps, {
          job,
          leaseToken: parsed.value.leaseToken,
          parsed: parsed.value,
          who: `runner=${who.runnerId}`,
          extraSecrets: [],
        });
        if ("response" in stored) return stored.response;
        deps.logger.info(
          `[runner-api] steps runner=${who.runnerId} job=${jobId} refused: lease lost`,
        );
        return errorResponse(409, "RUNNER_LEASE_LOST");
      } catch (error) {
        return unexpected("steps", error);
      }
    },

    async session(request, jobId) {
      try {
        const who = await identifyOwnedJob(request, jobId);
        if (!who.ok) return who.response;
        const body = await readLimitedBody(request, SNAPSHOT_LIMITS.partBytes);
        if (!body.ok) return errorResponse(413, "RUNNER_BODY_TOO_LARGE");
        const parsed = parseSnapshotPartRequest(
          new URL(request.url).searchParams,
          body.bytes,
        );
        if (!parsed.ok)
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: parsed.fields,
          });
        const stored = await storeSnapshotPart(deps, {
          job: who.job,
          leaseToken: who.leaseToken,
          parsed: parsed.value,
          who: `runner=${who.runnerId}`,
        });
        if ("response" in stored) return stored.response;
        deps.logger.info(
          `[runner-api] session runner=${who.runnerId} job=${jobId} refused: lease lost`,
        );
        return errorResponse(409, "RUNNER_LEASE_LOST");
      } catch (error) {
        return unexpected("session", error);
      }
    },

    async resumeSession(request, jobId) {
      try {
        const who = await identifyOwnedJob(request, jobId);
        if (!who.ok) return who.response;
        const asked = parseResumePart(new URL(request.url).searchParams);
        if (!asked.ok)
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: asked.fields,
          });
        const read = await readResumeSessionPart(deps, {
          job: who.job,
          leaseToken: who.leaseToken,
          part: asked.part,
          who: `runner=${who.runnerId}`,
        });
        if ("response" in read) return read.response;
        deps.logger.info(
          `[runner-api] resume-session runner=${who.runnerId} job=${jobId} refused: lease lost`,
        );
        return errorResponse(409, "RUNNER_LEASE_LOST");
      } catch (error) {
        return unexpected("resume-session", error);
      }
    },

    async jobState(request, jobId) {
      try {
        const who = identify(request);
        if (!who.ok) return who.response;
        if (!parseJobId(jobId))
          return errorResponse(400, "RUNNER_REQUEST_INVALID", {
            fields: [{ field: "jobId", code: "invalid" }],
          });
        return await handleJobState(deps, jobId);
      } catch (error) {
        return unexpected("job state", error);
      }
    },

    async version(request) {
      try {
        // The dispatcher credential, or the credential of a running claim with its job id: a Worker
        // checks the app before it fetches its job. #879: or the credential of a customer's runner, which reads
        // the features to know whether it may use a call the app of an earlier release lacks. No job data in the
        // answer; authenticating also marks the runner seen.
        const who = identify(request);
        if (
          !who.ok &&
          !(await isRunningClaim(request)) &&
          !(await isCustomerRunner(request))
        )
          return who.response;
        return jsonResponse(200, {
          version: RUNNER_API_VERSION,
          appVersion: deps.appVersion,
          features: [...APP_FEATURES],
        } satisfies VersionResponse);
      } catch (error) {
        return unexpected("version", error);
      }
    },
  };
}
