// SPDX-License-Identifier: LicenseRef-Proprietary

import type { SafeMessageError } from "../../errors.ts";

// Stable error codes of the GitHub App provider. Callers branch on `code`, never on the message. A
// message names the call and the status, never a key, a JWT, a token or a response body.
export const GITHUB_APP_ERROR_CODES = [
  "GITHUB_APP_CONFIG_INVALID",
  /** GitHub refused the App JWT or an installation token (HTTP 401). */
  "GITHUB_APP_AUTH_FAILED",
  /** HTTP 403 that is not a rate limit: the app lacks a permission or the installation is suspended. */
  "GITHUB_APP_FORBIDDEN",
  "GITHUB_APP_NOT_FOUND",
  /** HTTP 429, or 403 with a rate limit header. `retryAfterSeconds` tells when to try again. */
  "GITHUB_APP_RATE_LIMITED",
  /** HTTP 5xx, a network failure or a timeout: worth trying again later. */
  "GITHUB_APP_UNAVAILABLE",
  /** Any other unexpected answer, including a body that is not what the API documents. */
  "GITHUB_APP_REQUEST_FAILED",
] as const;

/**
 * Why GitHub refused a call with 403, or a token request with 422, as far as its answer says (#405). A closed set
 * read from the answer's message; the message itself is never kept. `permission_missing`: the App lacks a
 * permission or the installation has not accepted it. `repository_archived`: the repository is read-only.
 * `repository_not_accessible`: the repository is not part of the installation. `other`: GitHub said something else.
 * Two reasons name what a 422 of opening a pull request says (#844): `pull_request_exists` (one is open for this head and base
 * already) and `no_commits_between` (the head has nothing the base lacks).
 */
export const GITHUB_REFUSAL_REASONS = [
  "permission_missing",
  "repository_archived",
  "repository_not_accessible",
  "pull_request_exists",
  "no_commits_between",
  "other",
] as const;
export type GithubRefusalReason = (typeof GITHUB_REFUSAL_REASONS)[number];

export type GithubAppErrorCode = (typeof GITHUB_APP_ERROR_CODES)[number];

export class GithubAppError extends Error implements SafeMessageError {
  /** The messages of this provider name calls and statuses only; see `hasSafeMessage`. */
  readonly safeMessage = true as const;
  readonly code: GithubAppErrorCode;
  /** HTTP status of the answer; null for a network failure, a timeout or a configuration error. */
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  /**
   * True when the failure was GitHub's answer to the request for an installation token, not to the
   * call that needed the token. A 404 then means the installation is gone; a 404 of the call itself
   * means the thing it asked for does not exist (a pull request, a repository).
   */
  readonly duringTokenRequest: boolean;
  /** Why GitHub refused (403, or 422 for a token request); undefined where the answer was not read. */
  readonly refusal: GithubRefusalReason | undefined;

  constructor(
    code: GithubAppErrorCode,
    message: string,
    options: {
      status?: number | null;
      retryAfterSeconds?: number | null;
      duringTokenRequest?: boolean;
      refusal?: GithubRefusalReason;
    } = {},
  ) {
    super(message);
    this.name = "GithubAppError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.duringTokenRequest = options.duringTokenRequest ?? false;
    this.refusal = options.refusal;
  }
}

export type GithubAppConfigProblemKind = "missing" | "invalid";

/** The configuration is missing or invalid. `variables` are the names involved, never their values. */
export class GithubAppConfigError extends GithubAppError {
  readonly variables: readonly string[];
  readonly problem: GithubAppConfigProblemKind;

  constructor(
    variables: readonly string[],
    problem: GithubAppConfigProblemKind,
  ) {
    super(
      "GITHUB_APP_CONFIG_INVALID",
      `GitHub App configuration is invalid (${problem}): ${variables.join(", ")}.`,
    );
    this.name = "GithubAppConfigError";
    this.variables = variables;
    this.problem = problem;
  }
}
