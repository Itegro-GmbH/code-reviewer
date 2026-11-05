// SPDX-License-Identifier: LicenseRef-Proprietary

// The lease token of a runner call whose body is raw bytes (#879): the session snapshot of a customer's runner (`PUT
// /api/runners/v1/jobs/:id/session`) and its read (`GET .../resume-session`). The calls with a JSON body (heartbeat, complete,
// steps) carry the token in the body; here the body is the bytes of a part (or there is none), so it travels in a header. The
// rules for the value are those of `leaseToken` in a body (`LeaseToken` of the contract). A refusal names the header, never its value.
import type { Parsed } from "./requests.ts";
import { LEASE_TOKEN_LENGTH, lengthOf } from "./requests.ts";

/** The header that carries the lease token (a lower-case name: that is how `Headers` lists it). */
export const LEASE_TOKEN_HEADER = "x-lease-token";

/** The token of the header; a missing, too short or too long one is `RUNNER_REQUEST_INVALID` with the header's name. */
export function parseLeaseTokenHeader(header: string | null): Parsed<string> {
  if (header === null)
    return {
      ok: false,
      fields: [{ field: LEASE_TOKEN_HEADER, code: "required" }],
    };
  if (
    lengthOf(header) < LEASE_TOKEN_LENGTH.min ||
    lengthOf(header) > LEASE_TOKEN_LENGTH.max
  )
    return {
      ok: false,
      fields: [{ field: LEASE_TOKEN_HEADER, code: "invalid" }],
    };
  return { ok: true, value: header };
}
