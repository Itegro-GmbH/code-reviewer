// SPDX-License-Identifier: LicenseRef-Proprietary

// How the pages call the app's own JSON routes (activate a project, save settings, run the sync).
// One function so every call sends the same headers and every failure ends up as a stable code the
// page can translate: nothing here throws. The routes check where a request comes from, so the call
// must come from the page itself (`credentials: "same-origin"`, a JSON body).

export const TRANSPORT_ERROR_CODES = [
  /** The access proxy turned the request away: there is no session (any more). 401. */
  "UNAUTHENTICATED",
  /** The access proxy turned the request away: the signed in person is not on the allow list. 403. */
  "ACCESS_DENIED",
  /** The server could not be reached. */
  "NETWORK_ERROR",
  /** The answer was not what the route documents (not JSON, or an error without a code). */
  "UNEXPECTED_RESPONSE",
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

/** `fetch`, narrowed to what the pages use so a test can hand in a stand-in. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type RequestIssue = {
  field: string;
  code: string;
  /** #689: the operator's maximum per review in whole US cents, on a cost limit above it (`EXCEEDS_OPERATOR_MAXIMUM`). */
  maximumCents?: number;
};

export type RequestResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** The HTTP status, or null when there was no answer. */
      status: number | null;
      /** The route's error code or a transport code; a plain string because the routes own theirs. */
      code: string;
      issues: RequestIssue[];
      /** The other fields of the answer (a refusal that carries a number, for example); absent when there are none. */
      details?: Record<string, unknown>;
    };

function failure(
  status: number | null,
  code: string,
  issues: RequestIssue[] = [],
  details: Record<string, unknown> = {},
): RequestResult<never> {
  return Object.keys(details).length === 0
    ? { ok: false, status, code, issues }
    : { ok: false, status, code, issues, details };
}

function readIssues(value: unknown): RequestIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: RequestIssue[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    // The older routes name the place `field`, the project and tracker routes `path`.
    const { field, path, code, maximumCents } = entry as {
      field?: unknown;
      path?: unknown;
      code?: unknown;
      maximumCents?: unknown;
    };
    const place = typeof field === "string" ? field : path;
    if (typeof place === "string" && typeof code === "string")
      issues.push({
        field: place,
        code,
        ...(typeof maximumCents === "number" ? { maximumCents } : {}),
      });
  }
  return issues;
}

export async function requestJson<T>(
  fetchImpl: FetchLike,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  /** Aborting it ends the call as a `NETWORK_ERROR`; the caller that aborted ignores the result. */
  signal?: AbortSignal,
): Promise<RequestResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return failure(null, "NETWORK_ERROR");
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return failure(response.status, "UNEXPECTED_RESPONSE");
  }
  if (response.ok) return { ok: true, data: parsed as T };

  const { error, issues, ...details } = (
    typeof parsed === "object" && parsed !== null ? parsed : {}
  ) as { error?: unknown; issues?: unknown } & Record<string, unknown>;
  if (typeof error !== "string")
    return failure(response.status, "UNEXPECTED_RESPONSE");
  return failure(response.status, error, readIssues(issues), details);
}
