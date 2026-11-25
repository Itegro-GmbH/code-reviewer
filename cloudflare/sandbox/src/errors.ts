// SPDX-License-Identifier: LicenseRef-Proprietary

// The error kinds of the cf-sandbox API (contracts/cf-sandbox.v1.json, `ErrorResponse`): the kinds of `SANDBOX_FAILURE_KINDS` of
// dispatcher/src/launchers/sandbox-service.ts, each with the status the contract gives it. A body carries the kind and nothing else:
// no text of the platform, no path, no secret.
export const FAILURE_KINDS = [
  "rate_limited",
  "quota_exceeded",
  "network",
  "unavailable",
  "snapshot_missing",
  "region_mismatch",
  "not_ready",
  "rejected",
  "auth_failed",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

const STATUS: Record<FailureKind, number> = {
  rejected: 400,
  auth_failed: 401,
  not_ready: 404,
  rate_limited: 429,
  quota_exceeded: 429,
  unavailable: 503,
  network: 503,
  snapshot_missing: 503,
  region_mismatch: 503,
};

export function statusOf(kind: FailureKind): number {
  return STATUS[kind];
}

export function errorResponse(kind: FailureKind): Response {
  return Response.json({ error: kind }, { status: STATUS[kind] });
}

/** What a Durable Object answers: expected failures are values, because an exception does not keep its class across an RPC call. */
export type Result<T> =
  { ok: true; value: T } | { ok: false; kind: FailureKind };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
export function fail<T = never>(kind: FailureKind): Result<T> {
  return { ok: false, kind };
}
