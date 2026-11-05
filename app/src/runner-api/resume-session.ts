// SPDX-License-Identifier: LicenseRef-Proprietary

// What a resume-session request does once it is read (#840, follow-up turns): the Worker of a follow-up turn of the Implementer reads
// back the snapshot the earlier turns stored for the session, one part per request (`GET /api/workers/v1/jobs/:id/resume-session
// ?part=n`, the credential in the header), and, since #879, a customer's runner (`GET /api/runners/v1/jobs/:id/resume-session?part=n`: the
// runner credential in `Authorization`, the lease token in `X-Lease-Token`).
//
// The same rules as the snapshot's write, turned round:
//  - the call proves the claim and nothing else (a cheap look first, the proof in the repository); it does NOT extend the lease;
//  - only a turn of the Implementer reads a snapshot: a job of another kind is refused (400);
//  - the session is found from the job and from nothing the caller sends, so a job reads its own session's snapshot and no other;
//    only a snapshot of an EARLIER turn is read (the repository decides);
//  - the file is a response body, and a function of the platform holds a response to 4.5 MB like a request: it is served in the parts
//    the upload used (`SNAPSHOT_LIMITS.partBytes`), and every part carries the description of the whole in its headers, so a part is
//    judged on its own and the parts may be fetched in any order and twice;
//  - the bytes are served exactly as stored. The app never opens them and never logs them (what the agent read is in there).
import "server-only";
import type { Job } from "../jobs/job-types.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import { noContent } from "./responses.ts";
import { SNAPSHOT_LIMITS, type FieldError } from "./contract.ts";
import { errorResponse } from "./responses.ts";
import type { RunnerApiLogger } from "./logger.ts";
import type { SnapshotDeps } from "./snapshot.ts";
import { snapshotPartBytes, snapshotPartCount } from "./snapshot-request.ts";

/** The headers that describe the whole file on every part (`ResumeSessionHeaders` in the Worker contract). */
export const RESUME_SESSION_HEADERS = {
  parts: "x-snapshot-parts",
  bytes: "x-snapshot-bytes",
  rawBytes: "x-snapshot-raw-bytes",
  sha256: "x-snapshot-sha256",
  opencodeVersion: "x-snapshot-opencode-version",
} as const;

export type ResumeSessionDeps = Pick<SnapshotDeps, "snapshots"> & {
  queue: Pick<RunnerQueue, "holding">;
  logger: RunnerApiLogger;
};

/** `lost`: the caller does not hold the running claim; the caller decides which answer that is. */
export type ResumeSessionOutcome = { response: Response } | { lost: true };

/** Decimal digits without a leading zero, at most three: the range is `SNAPSHOT_LIMITS.maxParts`, checked below, not spelled here. */
const DIGITS = /^(0|[1-9]\d{0,2})$/;

/** The part asked for: `part` from 0 (absent is 0), at most `maxParts - 1`. A refusal lists the field, never the value. */
export function parseResumePart(
  query: URLSearchParams,
): { ok: true; part: number } | { ok: false; fields: FieldError[] } {
  const raw = query.get("part");
  if (raw === null) return { ok: true, part: 0 };
  if (!DIGITS.test(raw) || Number(raw) >= SNAPSHOT_LIMITS.maxParts)
    return { ok: false, fields: [{ field: "part", code: "invalid" }] };
  return { ok: true, part: Number(raw) };
}

/** Serves `part` of the snapshot of the session of the running turn `job` holds with `leaseToken`. */
export async function readResumeSessionPart(
  deps: ResumeSessionDeps,
  input: { job: Job; leaseToken: string; part: number; who: string },
): Promise<ResumeSessionOutcome> {
  const { job, leaseToken, part, who } = input;
  if (job.reviewKind !== "implementer") {
    deps.logger.info(
      `[runner-api] resume-session ${who} job=${job.id} refused: not a turn of the Implementer`,
    );
    return {
      response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
        fields: [{ field: "jobId", code: "invalid" }],
      }),
    };
  }
  // A cheap look before the read: a caller that does not hold the running claim costs one query. The repository proves the claim again.
  const holding = await deps.queue.holding(job.id, leaseToken);
  if (holding === undefined || holding.status !== "running")
    return { lost: true };
  const found = await deps
    .snapshots(job.workspaceId)
    .readForJob(job.id, leaseToken);
  if (found.status === "not_holder") return { lost: true };
  if (found.status === "no_session") {
    deps.logger.info(
      `[runner-api] resume-session ${who} job=${job.id} refused: no_session`,
    );
    return {
      response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
        fields: [{ field: "jobId", code: "invalid" }],
      }),
    };
  }
  // The session has nothing stored from an earlier turn: the turn continues from a summary.
  if (found.status === "none") return { response: noContent() };

  const { snapshot, data } = found;
  const count = snapshotPartCount(snapshot.bytes);
  if (part >= count || data.byteLength !== snapshot.bytes) {
    // A part beyond the last, or a stored file that is not the size it was stored with (never the case): nothing is served.
    if (data.byteLength !== snapshot.bytes)
      deps.logger.error(
        `[runner-api] resume-session ${who} job=${job.id}: the stored snapshot is not the size it was stored with`,
      );
    return {
      response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
        fields: [{ field: "part", code: "invalid" }],
      }),
    };
  }
  const start = part * SNAPSHOT_LIMITS.partBytes;
  const body = data.subarray(
    start,
    start + snapshotPartBytes(snapshot.bytes, part),
  );
  return {
    response: new Response(body as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.byteLength),
        "Cache-Control": "no-store",
        [RESUME_SESSION_HEADERS.parts]: String(count),
        [RESUME_SESSION_HEADERS.bytes]: String(snapshot.bytes),
        [RESUME_SESSION_HEADERS.rawBytes]: String(snapshot.rawBytes),
        [RESUME_SESSION_HEADERS.sha256]: snapshot.sha256,
        [RESUME_SESSION_HEADERS.opencodeVersion]: snapshot.opencodeVersion,
      },
    }),
  };
}
