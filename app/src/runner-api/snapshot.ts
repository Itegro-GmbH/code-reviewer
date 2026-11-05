// SPDX-License-Identifier: LicenseRef-Proprietary

// What a snapshot request does once it is read (#839, follow-up turns): one part of the session snapshot of a running turn of the
// Implementer is stored, and when it is the last one the snapshot is swapped in for the session's old one. Used by the Worker API
// (`PUT /api/workers/v1/jobs/:id/session`, the credential in the header); the runner API has no such call.
//
// Strict on our side, best effort on the sender's:
//  - the call proves the claim and nothing else (a cheap look first, the proof in the transaction that stores); it does NOT extend the
//    lease (only the heartbeat does);
//  - only a turn of the Implementer takes a snapshot: a job of another kind is refused (400), as it is for steps;
//  - the bytes are the runner's gzip of an export it already redacted. The app does not open them: it keeps them exactly as they came,
//    checks the size and the digest the runner announced, and never logs them. The repository's content is the exposure no filter can
//    know (a committed `.env` the agent printed): a member can read what the agent read, and so is whoever resumes it.
import "server-only";
import type { Job } from "../jobs/job-types.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import type { ImplementerSnapshotsRepository } from "../db/repositories/implementer-snapshots-repository.ts";
import { RUNNER_API_VERSION, type SessionPartResponse } from "./contract.ts";
import type { RunnerApiLogger } from "./logger.ts";
import { errorResponse, jsonResponse } from "./responses.ts";
import type { ParsedSnapshotPart } from "./snapshot-request.ts";

export type SnapshotDeps = {
  queue: Pick<RunnerQueue, "holding">;
  /** The snapshots of a job's workspace; scoped, like every repository of customer data. */
  snapshots: (workspaceId: string) => ImplementerSnapshotsRepository;
  logger: RunnerApiLogger;
};

/** `lost`: the caller does not hold the running claim; the caller decides which answer that is. */
export type StoreSnapshotOutcome = { response: Response } | { lost: true };

/** Stores the part of the running turn `job` holds with `leaseToken`. `who` names the caller in the log line (never a secret). */
export async function storeSnapshotPart(
  deps: SnapshotDeps,
  input: {
    job: Job;
    leaseToken: string;
    parsed: ParsedSnapshotPart;
    who: string;
  },
): Promise<StoreSnapshotOutcome> {
  const { job, leaseToken, parsed, who } = input;
  if (job.reviewKind !== "implementer") {
    deps.logger.info(
      `[runner-api] snapshot ${who} job=${job.id} refused: not a turn of the Implementer`,
    );
    return {
      response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
        fields: [{ field: "jobId", code: "invalid" }],
      }),
    };
  }
  // A cheap look before the transaction: a caller that does not hold the running claim costs one read. It decides nothing: the
  // repository proves the claim again in the transaction that stores the part.
  const holding = await deps.queue.holding(job.id, leaseToken);
  if (holding === undefined || holding.status !== "running")
    return { lost: true };
  const result = await deps
    .snapshots(job.workspaceId)
    .recordPart(job.id, leaseToken, parsed);
  if (result.status === "not_holder") return { lost: true };
  if (result.status === "no_session" || result.status === "invalid") {
    deps.logger.info(
      `[runner-api] snapshot ${who} job=${job.id} refused: ${result.status}`,
    );
    return {
      response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
        fields: [{ field: "body", code: "invalid" }],
      }),
    };
  }
  if (result.complete)
    deps.logger.info(
      `[runner-api] snapshot ${who} job=${job.id} stored (${parsed.size} bytes in ${parsed.count} parts)`,
    );
  return {
    response: jsonResponse(200, {
      version: RUNNER_API_VERSION,
      part: parsed.index,
      parts: parsed.count,
      complete: result.complete,
    } satisfies SessionPartResponse),
  };
}
