// SPDX-License-Identifier: LicenseRef-Proprietary

// What a steps request does once it is read (#745, live view): the records a running turn of the Implementer sent are cleaned and
// stored, one row for each part. Shared by the runner API (`POST /api/runners/v1/jobs/:id/steps`, the lease token in the body) and the
// Worker API (`POST /api/workers/v1/jobs/:id/steps`, the credential in the header), which differ only in how they know the caller.
//
// Best effort on the sender's side and strict on ours:
//  - the call proves the claim and nothing else; it does NOT extend the lease (only the heartbeat does), so a runner that sends
//    steps and no heartbeat still loses the job;
//  - only a turn of the Implementer takes steps: a job of another kind is refused (400), as it is for the implementer block of a
//    result;
//  - every text is cleaned as the result's texts are: control characters out, the secrets the app knows (the workspace key, the
//    key of the claim, the runner token, the Worker's own credential, anything shaped like a credential) replaced, and on the
//    operator's key the model and provider names too. The repository's content is the exposure no filter can know (a committed
//    `.env` the agent printed): a member can read what the agent read;
//  - the cost of a model call is not stored for a job on the operator's key: a member never reads it (`run-view.ts`);
//  - the caps of a turn (parts and bytes) are the repository's; what they refuse is counted in `dropped`.
import "server-only";
import { maskModelInText } from "../llm/access.ts";
import { maskProvidersInText } from "../llm/provider-mask.ts";
import type { Job } from "../jobs/job-types.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import type {
  ImplementerStepsRepository,
  StepWrite,
} from "../db/repositories/implementer-steps-repository.ts";
import {
  RUNNER_API_VERSION,
  type StepRecord,
  type StepsResponse,
} from "./contract.ts";
import type { RunnerApiLogger } from "./logger.ts";
import { redactBlockText } from "./redact.ts";
import type { ReportDeps } from "./report.ts";
import { withoutControlCharacters } from "./requests.ts";
import { errorResponse, jsonResponse } from "./responses.ts";
import type { ParsedSteps } from "./steps-request.ts";

export type StepsDeps = Pick<
  ReportDeps,
  "knownSecrets" | "claimedKeys" | "managedModels"
> & {
  queue: Pick<RunnerQueue, "get" | "holding">;
  /** The steps of a job's workspace; scoped, like every repository of customer data. */
  steps: (workspaceId: string) => ImplementerStepsRepository;
  logger: RunnerApiLogger;
};

/** `lost`: the caller does not hold the running claim; the caller decides which answer that is. */
export type StoreStepsOutcome = { response: Response } | { lost: true };

/** The record without what the row's columns hold, as the page will read it. Undefined fields are left out. */
function payloadOf(
  record: StepRecord,
  text: (value: string) => string,
  withCost: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    text: record.text === undefined ? undefined : text(record.text),
    bytes: record.bytes,
    tool: record.tool === undefined ? undefined : text(record.tool),
    status: record.status === undefined ? undefined : text(record.status),
    title: record.title === undefined ? undefined : text(record.title),
    input: record.input === undefined ? undefined : text(record.input),
    error: record.error === undefined ? undefined : text(record.error),
    reason: record.reason === undefined ? undefined : text(record.reason),
    tokens: record.tokens,
    cost: withCost ? record.cost : undefined,
  };
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
}

/**
 * Stores the batch of the running turn `job` holds with `leaseToken`. `extraSecrets` are values the caller itself holds (the
 * Worker's credential) that must not end up in a stored step either. `who` names the caller in the log line (never a secret).
 */
export async function storeSteps(
  deps: StepsDeps,
  input: {
    job: Job;
    leaseToken: string;
    parsed: ParsedSteps;
    who: string;
    extraSecrets: readonly string[];
  },
): Promise<StoreStepsOutcome> {
  const { job, leaseToken, parsed, who, extraSecrets } = input;
  if (job.reviewKind !== "implementer") {
    deps.logger.info(
      `[runner-api] steps ${who} job=${job.id} refused: not a turn of the Implementer`,
    );
    return {
      response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
        fields: [{ field: "jobId", code: "invalid" }],
      }),
    };
  }
  const remembered = await deps.claimedKeys.modelsOf(job.id);
  const managed = await deps.managedModels(job);
  const models = [...new Set([...remembered, ...managed.models])];
  const onManagedKey = managed.managed || remembered.length > 0;
  const secrets = [
    ...(await deps.knownSecrets(job.workspaceId)),
    ...(await deps.claimedKeys.keysOf(job.id)),
    ...extraSecrets,
  ];
  const clean = (value: string): string => {
    const redacted = redactBlockText(
      withoutControlCharacters(value).toWellFormed(),
      secrets,
    );
    return onManagedKey
      ? maskProvidersInText(maskModelInText(redacted, ...models))
      : redacted;
  };
  const writes: StepWrite[] = parsed.records.map((record) => ({
    partId: record.partId,
    seq: record.seq,
    kind: record.kind,
    payload: payloadOf(record, clean, !onManagedKey),
  }));
  const result = await deps
    .steps(job.workspaceId)
    .recordSteps(job.id, leaseToken, writes);
  if (result.status === "not_holder") return { lost: true };
  const dropped = result.dropped + parsed.unknownKind;
  if (dropped > 0)
    deps.logger.info(
      `[runner-api] steps ${who} job=${job.id} dropped ${dropped} of ${parsed.records.length + parsed.unknownKind}`,
    );
  return {
    response: jsonResponse(200, {
      version: RUNNER_API_VERSION,
      stored: result.stored,
      stale: result.stale,
      dropped,
    } satisfies StepsResponse),
  };
}
