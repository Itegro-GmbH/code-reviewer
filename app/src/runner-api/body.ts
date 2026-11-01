// SPDX-License-Identifier: LicenseRef-Proprietary

// Reading the JSON body of a runner API or Worker API request: up to the limit (a larger body is refused
// with 413 before it is parsed), then JSON. A refusal is the finished response; it never repeats the body.
import "server-only";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import type { Job } from "../jobs/job-types.ts";
import {
  IMPLEMENTER_MAX_BODY_BYTES,
  RUNNER_MAX_BODY_BYTES,
} from "./contract.ts";
import { errorResponse } from "./responses.ts";

export type Body =
  { ok: true; value: unknown } | { ok: false; response: Response };

function invalidBody(): Body {
  return {
    ok: false,
    response: errorResponse(400, "RUNNER_REQUEST_INVALID", {
      fields: [{ field: "body", code: "invalid" }],
    }),
  };
}

/** `maxBytes`: the limit of this request; the one every kind has unless the caller knows the job is a turn of the Implementer (#754). */
/** The limit of the report of `job` (#754): larger for a turn of the Implementer, the usual one for every other kind and for no job. */
export function bodyLimitFor(job: Pick<Job, "reviewKind"> | undefined): number {
  return job?.reviewKind === "implementer"
    ? IMPLEMENTER_MAX_BODY_BYTES
    : RUNNER_MAX_BODY_BYTES;
}

export async function readJsonBody(
  request: Request,
  maxBytes: number = RUNNER_MAX_BODY_BYTES,
): Promise<Body> {
  const body = await readLimitedBody(request, maxBytes);
  if (!body.ok)
    return { ok: false, response: errorResponse(413, "RUNNER_BODY_TOO_LARGE") };
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return invalidBody();
  }
}

/**
 * The claim body is optional (#195): a previous-release runner sends none. An empty body is the same
 * as no body; anything else must be JSON, and a body over the limit is refused before it is parsed.
 */
export async function readOptionalJsonBody(request: Request): Promise<Body> {
  const body = await readLimitedBody(request, RUNNER_MAX_BODY_BYTES);
  if (!body.ok)
    return { ok: false, response: errorResponse(413, "RUNNER_BODY_TOO_LARGE") };
  if (body.text.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return invalidBody();
  }
}

/**
 * Reads a body only to enforce the size limit and ignores what it says (the heartbeat of the Worker API:
 * the credential identifies the job, a body is accepted and ignored). Refused with 413 over the limit.
 */
export async function discardBody(request: Request): Promise<Response | null> {
  const body = await readLimitedBody(request, RUNNER_MAX_BODY_BYTES);
  return body.ok ? null : errorResponse(413, "RUNNER_BODY_TOO_LARGE");
}
