// SPDX-License-Identifier: LicenseRef-Proprietary

// Every answer of the runner API is built here, so the headers and the shape of an error are the
// same everywhere: `Cache-Control: no-store` (a claim carries credentials, and nothing a runner gets
// may be cached by a proxy), and errors as `{ error: { code, message } }` with a stable code.
import type {
  FieldError,
  RunnerApiErrorCode,
  ErrorResponse,
} from "./contract.ts";

const BASE_HEADERS = { "Cache-Control": "no-store" } as const;

/** What a person reads; callers branch on the code. Fixed texts: they never include request data. */
const MESSAGES: Record<RunnerApiErrorCode, string> = {
  RUNNER_UNAUTHORIZED: "A valid runner token is required.",
  RUNNER_ID_INVALID: "The X-Runner-Id header is not a valid runner id.",
  RUNNER_REQUEST_INVALID: "The request is not valid.",
  RUNNER_JOB_NOT_FOUND: "There is no such job.",
  RUNNER_LEASE_LOST: "The runner does not hold this job.",
  RUNNER_RESULT_CONFLICT: "The job was completed before with another result.",
  RUNNER_BODY_TOO_LARGE: "The request body is too large.",
  RUNNER_GIT_ACCESS_UNAVAILABLE:
    "Credentials for the job could not be created right now. Try again later.",
  RUNNER_INTERNAL_ERROR: "The request could not be handled.",
  WORKER_CREDENTIAL_INVALID: "A valid credential for this job is required.",
  RUNNER_JOB_ENDED: "The job was ended and cannot be continued.",
  RUNNER_REGISTRATION_TOKEN_INVALID:
    "The registration token is not valid. It may have been used or have expired.",
  RUNNER_UPDATE_NEEDED:
    "The runner is older than the minimum the app requires. Update it to get jobs.",
};

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { ...BASE_HEADERS, ...headers },
  });
}

/** `204`: there is nothing to do. No body. */
export function noContent(): Response {
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

export function errorResponse(
  status: number,
  code: RunnerApiErrorCode,
  extra: {
    fields?: FieldError[];
    retryAfterSeconds?: number;
    minBaseVersion?: string;
  } = {},
): Response {
  const body: ErrorResponse = {
    error: {
      code,
      message: MESSAGES[code],
      ...(extra.fields === undefined ? {} : { fields: extra.fields }),
      ...(extra.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: extra.retryAfterSeconds }),
      ...(extra.minBaseVersion === undefined
        ? {}
        : { minBaseVersion: extra.minBaseVersion }),
    },
  };
  return jsonResponse(
    status,
    body,
    extra.retryAfterSeconds === undefined
      ? {}
      : { "Retry-After": String(extra.retryAfterSeconds) },
  );
}

/**
 * The one answer to a missing or wrong token: the same status, headers and body in every case, so
 * the answer says nothing about how close a token was or whether one is configured at all.
 */
export function unauthorized(): Response {
  return jsonResponse(
    401,
    {
      error: {
        code: "RUNNER_UNAUTHORIZED",
        message: MESSAGES.RUNNER_UNAUTHORIZED,
      },
    } satisfies ErrorResponse,
    { "WWW-Authenticate": "Bearer" },
  );
}

/**
 * The one answer of the Worker API to a credential that is not the job's: missing, malformed, the
 * dispatcher credential, for another job, of an earlier claim, or for a job that does not exist. Same
 * status, headers and body in every case, so it says nothing about which jobs exist or how close a guess was.
 */
export function workerUnauthorized(): Response {
  return jsonResponse(
    401,
    {
      error: {
        code: "WORKER_CREDENTIAL_INVALID",
        message: MESSAGES.WORKER_CREDENTIAL_INVALID,
      },
    } satisfies ErrorResponse,
    { "WWW-Authenticate": "Bearer" },
  );
}
