// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/workers/v1/jobs/:id (#320): the Worker fetches its job. This is where the secrets of a split
// claim are created: the same checks and the same step 4 as the legacy claim (`checkJob`, then
// `buildJobInput` in claim.ts), only now for the Worker that holds the credential, so a Dispatcher never
// sees the git token or the model key.
//
//   - at most `MAX_WORKER_FETCHES` per claim (counted before anything is created); each fetch mints a
//     fresh installation token;
//   - the model key is remembered (`job_claimed_keys`) before it leaves, so a result is masked even after
//     the key was rotated, whichever app instance serves it;
//   - a permanent failure ends the job with its stable code and answers 409 RUNNER_JOB_ENDED; a failure
//     that may pass gives the job back (an attempt is counted) and answers 503 with Retry-After; anything
//     unexpected gives the job back and answers 500.
import "server-only";
import type { Job } from "../jobs/job-types.ts";
import {
  buildJobInput,
  cancelJob,
  checkJob,
  endJob,
  giveBack,
  noInputHandedOut,
  type ClaimDeps,
  type Origin,
} from "./claim.ts";
import {
  MAX_WORKER_FETCHES,
  RUNNER_API_VERSION,
  type WorkerJobDetailsResponse,
} from "./contract.ts";
import { standingRefusal } from "../usage/enforce-entitlements.ts";
import { describeError } from "./logger.ts";
import {
  callerLlmProviders,
  parseWorkerFeatures,
  parseWorkerLlmProviders,
} from "./requests.ts";
import {
  errorResponse,
  jsonResponse,
  workerUnauthorized,
} from "./responses.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import type { GitTokenEntry } from "./claimed-keys.ts";

const ORIGIN: Origin = { label: "fetch worker", stage: "fetch" };

type FetchDeps = ClaimDeps & {
  queue: Pick<RunnerQueue, "holding" | "countFetch" | "get" | "noteSupersede">;
};

export async function handleFetch(
  deps: FetchDeps,
  { job, leaseToken, url }: { job: Job; leaseToken: string; url: URL },
): Promise<Response> {
  const features = parseWorkerFeatures(url.searchParams.get("features"));

  const counted = await deps.queue.countFetch(
    job.id,
    leaseToken,
    MAX_WORKER_FETCHES,
  );
  if (counted === "not_holder") {
    // The claim ended since the credential was checked.
    deps.logger.info(`[worker-api] fetch job=${job.id} refused: not held`);
    return errorResponse(409, "RUNNER_JOB_ENDED");
  }
  if (counted === "exhausted") {
    deps.logger.info(
      `[worker-api] fetch job=${job.id} refused: the fetches of this claim are used up`,
    );
    return workerUnauthorized();
  }

  // #397: this Worker stops gracefully when its run is superseded, so a newer push may supersede it.
  if (features.includes("supersede"))
    await deps.queue.noteSupersede(job.id, leaseToken);

  const claimed = { job, leaseToken };
  // The write token of a turn of the Implementer, once it is made: switched off if the input cannot be handed to the Worker (#753).
  let writeToken: GitTokenEntry | null = null;
  // Asked before anything is made: whether an earlier fetch of this turn handed an input to a Worker (#753).
  const beforeStart = await noInputHandedOut(deps, job);
  try {
    // The claim admitted the job; the workspace may have been suspended since, or its entitlements may have become
    // unreadable. No key and no token are made then: the job ends with the code of the claim. Quotas were
    // decided at the claim and are not counted again.
    const standing = standingRefusal(
      await deps.entitlementsFor(job.workspaceId),
    );
    if (standing !== null) {
      await endJob(deps, claimed, ORIGIN, standing);
      return errorResponse(409, "RUNNER_JOB_ENDED");
    }
    // #424, #432: the providers this Worker can run, from its own details call. The Dispatcher's claim cannot say, so
    // the decision is made here; a Worker that names none can run the default provider only.
    const checked = await checkJob(deps, job, {
      engines: null,
      classifyReadFailures: true,
      runnerProviders: callerLlmProviders(
        parseWorkerLlmProviders(url.searchParams.get("llmProviders")),
      ),
    });
    const outcome =
      checked.kind === "checked"
        ? await buildJobInput(deps, job, checked, features)
        : checked;

    if (outcome.kind === "refused") {
      await endJob(deps, claimed, ORIGIN, outcome.errorCode, outcome.detail);
      return errorResponse(409, "RUNNER_JOB_ENDED");
    }
    if (outcome.kind === "cancelled") {
      await cancelJob(deps, claimed, ORIGIN, outcome.errorCode);
      return errorResponse(409, "RUNNER_JOB_ENDED");
    }
    if (outcome.kind === "retry") {
      await giveBack(
        deps,
        claimed,
        outcome.reason,
        new Date(deps.now().getTime() + outcome.retryAfterSeconds * 1000),
        beforeStart,
      );
      deps.logger.info(
        `[worker-api] fetch job=${job.id} given back: ${outcome.reason}`,
      );
      return errorResponse(503, "RUNNER_GIT_ACCESS_UNAVAILABLE", {
        retryAfterSeconds: outcome.retryAfterSeconds,
      });
    }

    writeToken = outcome.writeToken;
    // Before the key leaves with the response: if it cannot be remembered, the job is given back (below)
    // and the Worker does not have the key.
    await deps.claimedKeys.remember(job.id, outcome.input.llm.apiKey);
    if (outcome.entryModel !== null)
      await deps.claimedKeys.rememberModel(job.id, outcome.entryModel);
    await deps.claimedKeys.rememberNative(job.id, outcome.native);
    // The token is remembered (sealed) before it leaves, so the end of the turn can switch it off (#753).
    if (outcome.writeToken !== null)
      await deps.claimedKeys.rememberGitToken(
        job.id,
        outcome.writeToken.token,
        outcome.writeToken.expiresAt,
      );
    const current = await deps.queue.get(job.id);
    if (current?.leaseExpiresAt == null)
      throw new Error(`Job ${job.id} has no lease expiry at fetch.`);
    deps.logger.info(
      `[worker-api] fetch job=${job.id} command=${job.command} details handed out`,
    );
    return jsonResponse(200, {
      version: RUNNER_API_VERSION,
      job: {
        id: job.id,
        leaseExpiresAt: current.leaseExpiresAt,
        heartbeatIntervalSeconds: deps.heartbeatIntervalSeconds,
        tokenExpiresAt: outcome.tokenExpiresAt,
        input: outcome.input,
      },
    } satisfies WorkerJobDetailsResponse);
  } catch (error) {
    deps.logger.error(
      `[worker-api] fetch job=${job.id} failed: ${describeError(error)}`,
    );
    if (writeToken !== null) await deps.revokeUndelivered(job, writeToken);
    await giveBack(deps, claimed, "claim_failed", undefined, beforeStart);
    return errorResponse(500, "RUNNER_INTERNAL_ERROR");
  }
}
