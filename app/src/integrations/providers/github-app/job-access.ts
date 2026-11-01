// SPDX-License-Identifier: LicenseRef-Proprietary

// What a job may do on GitHub and how a failed attempt to get that is reported. The token itself is
// minted by `client.mintInstallationToken` (the one place that does it) and wrapped by the provider.
import { IntegrationError, type IntegrationErrorCode } from "../../errors.ts";
import type { InstallationPermissions } from "./client.ts";
import { GithubAppError } from "./errors.ts";

/**
 * The least a review job needs: write comments and reviews on pull requests and issues, read the
 * code (the runner never pushes), and the metadata every token gets anyway. Nothing else, so a
 * leaked job token cannot change code, settings, workflows or other repositories.
 */
export const JOB_TOKEN_PERMISSIONS: InstallationPermissions = {
  pull_requests: "write",
  issues: "write",
  contents: "read",
  metadata: "read",
};

/**
 * What the token of a notice (#281) may do: write a comment below a pull request (GitHub files the comments of a
 * pull request under issues) and the metadata every token gets anyway. No code, no pull request settings.
 */
export const NOTICE_TOKEN_PERMISSIONS: InstallationPermissions = {
  issues: "write",
  metadata: "read",
};

/**
 * What the token of the Implementer (#749) may do: write the contents of one repository (push a branch) and the
 * metadata every token gets anyway. No pull requests, no issues, no checks, and no `workflows`: GitHub rejects a push
 * that touches `.github/workflows/**` without that permission, and the App never asks for it.
 */
export const IMPLEMENTER_TOKEN_PERMISSIONS: InstallationPermissions = {
  contents: "write",
  metadata: "read",
};

/** What the token that reads a posted review comment (#657) may do: read the comments of one repository and the metadata. */
export const COMMENT_READ_TOKEN_PERMISSIONS: InstallationPermissions = {
  issues: "read",
  metadata: "read",
};

/** What the token of the branch reads (#750) may do: read the contents of one repository and the metadata. */
export const BRANCH_READ_TOKEN_PERMISSIONS: InstallationPermissions = {
  contents: "read",
  metadata: "read",
};

/** The repository ids a job token is limited to: exactly one, and a real GitHub id. */
export function jobTokenRepositoryIds(repoExternalId: string): number[] | null {
  if (!/^[1-9]\d*$/.test(repoExternalId)) return null;
  const id = Number(repoExternalId);
  return Number.isSafeInteger(id) ? [id] : null;
}

const CODE_FOR: Partial<Record<GithubAppError["code"], IntegrationErrorCode>> =
  {
    GITHUB_APP_NOT_FOUND: "INTEGRATION_ACCESS_CONNECTION_GONE",
    GITHUB_APP_FORBIDDEN: "INTEGRATION_ACCESS_CONNECTION_SUSPENDED",
    GITHUB_APP_AUTH_FAILED: "INTEGRATION_ACCESS_APP_AUTH_FAILED",
    GITHUB_APP_RATE_LIMITED: "INTEGRATION_ACCESS_RATE_LIMITED",
    GITHUB_APP_UNAVAILABLE: "INTEGRATION_ACCESS_UNAVAILABLE",
  };

/**
 * Turns whatever went wrong while getting a job token into an `IntegrationError` with a stable,
 * provider neutral code. The message is the GitHub client's own (it names the call and the status,
 * never a credential or a response body); the original error is kept as `cause`.
 *
 * - 404 on the token call: the installation no longer exists.
 * - 403 (not a rate limit): GitHub refuses the app access to the installation. It is normally a
 *   suspended installation, but GitHub does not say why, so a user facing message must stay neutral
 *   ("access to the installation is refused or it is suspended"). A rate limit is checked first.
 * - 422: GitHub refused the narrow scope (repository not in the installation, or a permission the
 *   app does not hold). It never falls back to a broader token.
 */
export function toJobAccessError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  if (!(error instanceof GithubAppError))
    return new IntegrationError(
      "INTEGRATION_ACCESS_FAILED",
      "Credentials for the job could not be created.",
    );
  const code =
    error.code === "GITHUB_APP_REQUEST_FAILED" && error.status === 422
      ? "INTEGRATION_ACCESS_SCOPE_REFUSED"
      : (CODE_FOR[error.code] ?? "INTEGRATION_ACCESS_FAILED");
  return new IntegrationError(code, error.message, {
    cause: error,
    retryAfterSeconds: error.retryAfterSeconds,
  });
}

/**
 * `toJobAccessError` for the token of the Implementer (#749). A 422 that says the installation has not accepted a
 * permission the App holds (the owner of the installation has not approved Contents: write yet) is
 * `INTEGRATION_ACCESS_PERMISSION_NOT_GRANTED` (not retryable), told apart from a repository the installation does not
 * have (`INTEGRATION_ACCESS_SCOPE_REFUSED`). Everything else is what a job token gets.
 */
export function toImplementerAccessError(error: unknown): IntegrationError {
  if (
    error instanceof GithubAppError &&
    error.code === "GITHUB_APP_REQUEST_FAILED" &&
    error.status === 422 &&
    error.duringTokenRequest &&
    error.refusal === "permission_missing"
  )
    return new IntegrationError(
      "INTEGRATION_ACCESS_PERMISSION_NOT_GRANTED",
      error.message,
      { cause: error },
    );
  return toJobAccessError(error);
}

/**
 * The same for a read call (listing or fetching pull requests). A refusal of the app (401, 403), a
 * 404 and a rate limit mean what they mean for a job token; the rest has no special meaning here: a
 * 422 is not "the app has no access" (that code is for a refused token scope), so it and any other
 * unexpected failure become `INTEGRATION_ACCESS_FAILED`. The message names the call and the status
 * only, or says that GitHub could not be asked.
 */
export function toReadError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  if (!(error instanceof GithubAppError))
    return new IntegrationError(
      "INTEGRATION_ACCESS_FAILED",
      "GitHub could not be asked.",
    );
  return new IntegrationError(
    CODE_FOR[error.code] ?? "INTEGRATION_ACCESS_FAILED",
    error.message,
    { cause: error, retryAfterSeconds: error.retryAfterSeconds },
  );
}

/**
 * What the token of a check run (#405) may do: write check runs of one repository and the metadata every token gets
 * anyway. No code, no comments, no reviews: the review verdict has a token of its own.
 */
export const CHECK_TOKEN_PERMISSIONS: InstallationPermissions = {
  checks: "write",
  metadata: "read",
};

/** What the token of a review verdict (#405) may do: reviews of pull requests and the metadata. */
export const VERDICT_TOKEN_PERMISSIONS: InstallationPermissions = {
  pull_requests: "write",
  metadata: "read",
};

/**
 * The same for a write the app makes itself (a check run, a review). On top of `toReadError`:
 * - 422 on the token request, or 403 on the call: the app is not granted the permission (or the installation has
 *   not accepted it yet): `INTEGRATION_ACCESS_SCOPE_REFUSED`, the code by which the caller knows a permission is
 *   missing. GitHub's reason (`GithubAppError.refusal`) tells it from a read-only (archived) repository
 *   (`INTEGRATION_REPOSITORY_ARCHIVED`), a repository outside the installation
 *   (`INTEGRATION_REPOSITORY_NOT_ACCESSIBLE`) and a refusal for another reason (the normal retry path);
 * - 422 on the call itself: the platform refuses what was sent (a review of the app's own pull request):
 *   `INTEGRATION_REQUEST_REFUSED`.
 */
export function toWriteError(error: unknown): IntegrationError {
  if (!(error instanceof GithubAppError)) return toReadError(error);
  const refusedScope =
    (error.code === "GITHUB_APP_REQUEST_FAILED" &&
      error.status === 422 &&
      error.duringTokenRequest) ||
    (error.code === "GITHUB_APP_FORBIDDEN" && !error.duringTokenRequest);
  // What GitHub said about a refusal decides what it means: a read-only repository and one outside the installation
  // are not a missing permission, and a 403 for another reason is retried like any failure.
  if (refusedScope && error.refusal === "repository_archived")
    return new IntegrationError(
      "INTEGRATION_REPOSITORY_ARCHIVED",
      error.message,
      {
        cause: error,
      },
    );
  if (refusedScope && error.refusal === "repository_not_accessible")
    return new IntegrationError(
      "INTEGRATION_REPOSITORY_NOT_ACCESSIBLE",
      error.message,
      { cause: error },
    );
  if (refusedScope && error.refusal === "other") return toReadError(error);
  if (refusedScope)
    return new IntegrationError(
      "INTEGRATION_ACCESS_SCOPE_REFUSED",
      error.message,
      {
        cause: error,
      },
    );
  if (error.code === "GITHUB_APP_REQUEST_FAILED" && error.status === 422)
    return new IntegrationError("INTEGRATION_REQUEST_REFUSED", error.message, {
      cause: error,
    });
  return toReadError(error);
}
