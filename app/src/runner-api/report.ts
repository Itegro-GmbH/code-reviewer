// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/runners/v1/jobs/:id/heartbeat and /complete: what a runner says about a job it holds.
// Both prove the claim with the lease token of the claim response (not with the runner id, which is
// bookkeeping only), so a stale execution of a job that was requeued and claimed again gets 409
// even under the same runner id.
//
// The answers never contain the git token or the LLM key: only the claim response does.
import "server-only";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import type { Job, JobOutcome } from "../jobs/job-types.ts";
import {
  RUNNER_API_VERSION,
  RUNNER_ERROR_CODES,
  type CompleteResponse,
  type HeartbeatResponse,
  type RunnerResult,
} from "./contract.ts";
import type { ClaimedKeys } from "./claimed-keys.ts";
import { maskModelInText } from "../llm/access.ts";
import { maskProvidersInText } from "../llm/provider-mask.ts";
import { withoutUnaccountedManagedSuccess } from "./managed-cost-guard.ts";
import { implementerBlockProblems } from "./implementer-report.ts";
import { redactResult } from "./redact.ts";
import type { JobEndedEvent } from "../dispatch/job-ended.ts";
import type { RunnerApiLogger } from "./logger.ts";
import {
  parseCompleteRequest,
  parseHeartbeatRequest,
  type Parsed,
} from "./requests.ts";
import { errorResponse, jsonResponse } from "./responses.ts";
import type { WriteTokenRevoker } from "./write-token.ts";

export type ReportDeps = {
  queue: Pick<RunnerQueue, "get" | "heartbeat" | "complete" | "release">;
  logger: RunnerApiLogger;
  /**
   * Exact values that must never end up in a stored result: the runner token and the CURRENT LLM key of
   * the workspace the job belongs to (and the legacy variable, where it applies). Best effort; a lookup that
   * fails gives an empty list rather than failing the completion.
   */
  knownSecrets: (workspaceId: string) => Promise<readonly string[]>;
  /**
   * The LLM key each job was handed with its claim, which may differ from the current one, and the model of a managed
   * entry it was handed (#280, #432). Read from the database.
   */
  claimedKeys: Pick<ClaimedKeys, "keysOf" | "modelsOf" | "wasNative">;
  /**
   * Whether the job ran on the operator's key (its usage record says so), and every model id of every catalog entry,
   * whatever its status (#280, #432). The remembered model of the job is not enough: its row may be unreadable, the
   * runner may spell the model differently, and the result may name another entry's model.
   */
  managedModels: (
    job: Job,
  ) => Promise<{ managed: boolean; models: readonly string[] }>;
  /**
   * #395: a job ended or went back to the queue through this call. The running server uses it to send the jobs that
   * were waiting for the slot, after the response; it never throws and never delays the answer.
   */
  jobEnded?: (event: JobEndedEvent) => void;
  /**
   * #753: the turn is over, whether its result was stored or the job was given back: switches off the write tokens of a turn of the
   * Implementer (the review of #776). Never rejects; does nothing for another kind. Left out, nothing is switched off here.
   */
  revokeWriteTokens?: WriteTokenRevoker;
  /** #395: an authenticated call touched the database (a heartbeat, a result): the running server may do repair work. */
  activity?: () => void;
};

/** What `jobEnded` is told about a job. */
export function endOf(job: Job, requeued: boolean): JobEndedEvent {
  return {
    jobId: job.id,
    repositoryId: job.repositoryId,
    prNumber: job.prNumber,
    requeued,
  };
}

/**
 * The code a runner reports when it is shut down while it holds a job (CR-29). The job did not fail
 * for its own reasons, so it is given back to the queue instead of being finished.
 */
export const RUNNER_SHUTDOWN_CODE = "runner_shutdown";

/** The code a failed job is stored with: a code the runner is known to use, or `unknown`. */
export function mapRunnerErrorCode(code: string): string {
  return RUNNER_ERROR_CODES.some((known) => known === code) ? code : "unknown";
}

/**
 * The result without the model of a catalog entry (#280, #432): `usage.model` is not reported (null) whatever the runner calls
 * the model, and the ids become `[model]` in the text fields at any length (the generic rule that follows ignores
 * secrets shorter than a credential could be). The link to the comment is left alone: the app builds it from GitHub
 * data, it never carries a model, and a short id that also occurs in a repository name would break the link. The
 * provider is taken out of the text the same way (`[provider]`). `hide` is whether the job ran on the operator's key. The text
 * of an Implementer turn that an agent wrote (#754: the summary and the subjects of its commits) is cleaned the same way; its
 * file paths are the repository's and are left as they are, like the link to the comment.
 */
export function withoutManagedModel(
  result: RunnerResult,
  models: readonly string[],
  hide: boolean,
): RunnerResult {
  if (!hide) return result;
  // The provider goes with the model: an error class or a message of the provider names it (ADR 0005, 2.17).
  const mask = (text: string) =>
    maskProvidersInText(maskModelInText(text, ...models));
  return {
    ...result,
    logTail: mask(result.logTail),
    errorMessage:
      result.errorMessage === null ? null : mask(result.errorMessage),
    usage: result.usage === null ? null : { ...result.usage, model: null },
    ...(result.implementer === undefined
      ? {}
      : {
          implementer: {
            ...result.implementer,
            summary: mask(result.implementer.summary),
            commits: result.implementer.commits.map((commit) => ({
              ...commit,
              subject: mask(commit.subject),
            })),
          },
        }),
  };
}

function invalid(parsed: Extract<Parsed<unknown>, { ok: false }>): Response {
  return errorResponse(400, "RUNNER_REQUEST_INVALID", {
    fields: parsed.fields,
  });
}

/** The answer to an accepted heartbeat; `superseded` (#397) tells a run that a newer push replaced it. */
export function heartbeatAnswer(
  job: Job,
  superseded: boolean,
): HeartbeatResponse {
  if (job.heartbeatAt === null || job.leaseExpiresAt === null)
    throw new Error(`Heartbeat of job ${job.id} left no times.`);
  return {
    version: RUNNER_API_VERSION,
    job: {
      id: job.id,
      heartbeatAt: job.heartbeatAt,
      leaseExpiresAt: job.leaseExpiresAt,
      ...(superseded ? { superseded: true } : {}),
    },
  };
}

export async function handleHeartbeat(
  deps: ReportDeps,
  jobId: string,
  runnerId: string,
  body: unknown,
): Promise<Response> {
  const parsed = parseHeartbeatRequest(body);
  if (!parsed.ok) return invalid(parsed);

  if ((await deps.queue.get(jobId)) === undefined)
    return errorResponse(404, "RUNNER_JOB_NOT_FOUND");

  const result = await deps.queue.heartbeat(jobId, parsed.value.leaseToken);
  if (result.status === "not_holder") {
    deps.logger.info(
      `[runner-api] heartbeat runner=${runnerId} job=${jobId} refused: lease lost`,
    );
    return errorResponse(409, "RUNNER_LEASE_LOST");
  }
  deps.activity?.();
  return jsonResponse(
    200,
    heartbeatAnswer(result.job, result.status === "superseded"),
  );
}

/** The fields of a result that were malformed and left out (#541): their paths only, never a value. */
export function logDropped(
  deps: Pick<ReportDeps, "logger">,
  what: string,
  dropped: readonly string[],
): void {
  for (const field of dropped)
    deps.logger.info(`[runner-api] ${what} dropped ${field}: invalid`);
}

export async function handleComplete(
  deps: ReportDeps,
  jobId: string,
  runnerId: string,
  body: unknown,
): Promise<Response> {
  const parsed = parseCompleteRequest(body);
  if (!parsed.ok) return invalid(parsed);

  const job = await deps.queue.get(jobId);
  if (job === undefined) return errorResponse(404, "RUNNER_JOB_NOT_FOUND");
  logDropped(deps, `complete runner=${runnerId} job=${jobId}`, parsed.dropped);

  return finishJob(deps, {
    job,
    leaseToken: parsed.value.leaseToken,
    result: parsed.value.result,
    who: `runner=${runnerId}`,
    releaseCodes: [RUNNER_SHUTDOWN_CODE],
    extraSecrets: [],
  });
}

/**
 * The rest of a completion, shared by the runner API's `complete` and the Worker API's `result` (#320):
 * redact, store, or give the job back. `who` names the caller in the log line (never a secret),
 * `releaseCodes` are the error codes that give the job back instead of storing the result (the runner
 * API knows `runner_shutdown`; the Worker API adds `launch_failed`), and `extraSecrets` are values the
 * caller itself holds (the Worker's own credential) that must not end up in the stored result either.
 */
export async function finishJob(
  deps: ReportDeps,
  {
    job,
    leaseToken,
    result: reported,
    who,
    releaseCodes,
    extraSecrets,
  }: {
    job: Job;
    leaseToken: string;
    result: RunnerResult;
    who: string;
    releaseCodes: readonly string[];
    extraSecrets: readonly string[];
  },
): Promise<Response> {
  const jobId = job.id;
  // #754: the implementer block belongs to a turn and to no other job, and a turn that succeeded has to carry it. Refused like
  // any invalid result: nothing is stored and the job is not completed by it.
  const problems = implementerBlockProblems(job.reviewKind, reported);
  if (problems.length > 0) {
    deps.logger.info(
      `[runner-api] complete ${who} job=${jobId} refused: ${problems.map((problem) => `${problem.field} ${problem.code}`).join(", ")}`,
    );
    return invalid({ ok: false, fields: problems });
  }
  // What is stored: the checked result with everything that looks like a credential removed. The
  // same report always gives the same stored value, which is what makes a repetition recognisable.
  // The key of the claim and the current one: the key may have been rotated while the job ran, and the
  // claim may have been served by another app instance (the key of the claim is in the database).
  //
  // The model of a managed catalog entry is operator data a workspace must never read (#280): the job may repeat it in its
  // log or its error, and reports it as `usage.model`, which a Runs page shows. The model the job was handed is
  // remembered with its keys, so it is taken out whichever app instance serves the completion and whatever the
  // operator changed since; the tokens and the cost of the usage stay.
  const remembered = await deps.claimedKeys.modelsOf(jobId);
  const managed = await deps.managedModels(job);
  const models = [...new Set([...remembered, ...managed.models])];
  const onManagedKey = managed.managed || remembered.length > 0;
  const stored = redactResult(
    withoutManagedModel(
      // #553: a managed Dynamic run never settles with an unknown cost; a success that reports none is stored as the failure.
      withoutUnaccountedManagedSuccess(reported, {
        managed: onManagedKey,
        // #553, #578: native is what the claim handed out, not what the switch says by now.
        native: onManagedKey && (await deps.claimedKeys.wasNative(jobId)),
        reviewKind: job.reviewKind,
      }),
      models,
      onManagedKey,
    ),
    [
      ...(await deps.knownSecrets(job.workspaceId)),
      ...(await deps.claimedKeys.keysOf(jobId)),
      ...extraSecrets,
    ],
  );
  const outcome: JobOutcome =
    stored.errorCode === null
      ? { ok: true, result: stored }
      : {
          ok: false,
          errorCode: mapRunnerErrorCode(stored.errorCode),
          result: stored,
        };

  // A runner that is shut down gives the job back: it waits again (one attempt counted, the same cap
  // as a lapsed lease) instead of failing for good with every redeploy. The result is not stored.
  if (stored.errorCode !== null && releaseCodes.includes(stored.errorCode)) {
    // #754: a runner shut down by a redeploy may have pushed before it was; a turn of the Implementer keeps what it reports. A
    // launch that failed ran no agent and records nothing, whatever the body says.
    const released = await deps.queue.release(
      jobId,
      leaseToken,
      stored.errorCode,
      stored.errorCode === RUNNER_SHUTDOWN_CODE ? { result: stored } : {},
    );
    if (released.status === "not_holder") {
      deps.logger.info(
        `[runner-api] complete ${who} job=${jobId} refused: lease lost`,
      );
      return errorResponse(409, "RUNNER_LEASE_LOST");
    }
    deps.logger.info(
      `[runner-api] complete ${who} job=${jobId} given back: ${stored.errorCode} (${released.status})`,
    );
    deps.jobEnded?.(endOf(released.job, released.status === "requeued"));
    await deps.revokeWriteTokens?.(released.job);
    return jsonResponse(200, {
      version: RUNNER_API_VERSION,
      job: {
        id: released.job.id,
        status: released.status === "requeued" ? "queued" : "failed",
      },
      alreadyCompleted: false,
    } satisfies CompleteResponse);
  }

  const result = await deps.queue.complete(jobId, leaseToken, outcome);
  switch (result.status) {
    case "not_holder":
      deps.logger.info(
        `[runner-api] complete ${who} job=${jobId} refused: lease lost`,
      );
      return errorResponse(409, "RUNNER_LEASE_LOST");
    case "outcome_conflict":
      deps.logger.info(
        `[runner-api] complete ${who} job=${jobId} refused: another result was stored before`,
      );
      return errorResponse(409, "RUNNER_RESULT_CONFLICT");
    case "completed":
    case "already_completed": {
      const status = result.job.status;
      // `superseded` (#397): the report of a run a newer push replaced is stored and the job stays superseded.
      if (
        status !== "succeeded" &&
        status !== "failed" &&
        status !== "superseded"
      )
        throw new Error(`Completed job ${jobId} has the status ${status}.`);
      deps.logger.info(
        `[runner-api] complete ${who} job=${jobId} status=${status}${result.status === "already_completed" ? " (repeated)" : ""}`,
      );
      if (result.status === "completed")
        deps.jobEnded?.(endOf(result.job, false));
      // Also a repeated report: a token a first call could not switch off is tried again, and none is revoked twice.
      await deps.revokeWriteTokens?.(result.job);
      deps.activity?.();
      return jsonResponse(200, {
        version: RUNNER_API_VERSION,
        job: { id: result.job.id, status },
        alreadyCompleted: result.status === "already_completed",
      } satisfies CompleteResponse);
    }
  }
}
