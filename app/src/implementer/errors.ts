// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable error codes of the routes behind the Implementer form (#755). A caller (the route, a test, the form) branches on
// `code`, never on the message; the UI translates codes to copy.
import type { BranchNameIssue } from "./branch-name.ts";

export const IMPLEMENTER_ERROR_CODES = [
  /** The body is not usable (`issues` names the fields), or an id in the address is malformed. 400. */
  "IMPLEMENTER_REQUEST_INVALID",
  /** The request does not come from this site (cross-site `Sec-Fetch-Site` or a foreign `Origin`). 403. */
  "IMPLEMENTER_CROSS_SITE_REQUEST",
  /** The body is larger than the limit. 413. */
  "IMPLEMENTER_BODY_TOO_LARGE",
  /** The content type is not `application/json`. 415. */
  "IMPLEMENTER_CONTENT_TYPE_UNSUPPORTED",
  /** No repository of this workspace has this id, or it is no longer listed by the platform. Both look the same. 404. */
  "IMPLEMENTER_REPOSITORY_NOT_FOUND",
  /** The integration is disabled, or the platform refuses the app access to the repository. 409. */
  "IMPLEMENTER_APP_NOT_INSTALLED",
  /** The installation has not accepted the permission to write contents. 409. */
  "IMPLEMENTER_WRITE_NOT_GRANTED",
  /** The repository has no branch with the name of the base branch. 404. */
  "IMPLEMENTER_BASE_BRANCH_NOT_FOUND",
  /**
   * The new branch exists on the platform, or a session of this repository holds the name already. A turn that fails before it
   * starts keeps its name (accepted for the first slice), so the person needs a new branch name then. 409.
   */
  "IMPLEMENTER_BRANCH_EXISTS",
  /**
   * The new name is a folder of a branch that exists, or a branch of the repository is a folder of the new name (git holds a
   * name as a file or as a folder, not both: `foo` and `foo/bar`). Found in the first 100 branches the platform lists. 409.
   */
  "IMPLEMENTER_BRANCH_CONFLICT",
  /**
   * The client request id made a task before, and this body is not that task's (another instruction, branch, base branch,
   * repository, model or cost limit). Nothing is written; the answer carries the `runId` of the task the id made. 409.
   */
  "IMPLEMENTER_REQUEST_REUSED",
  /** The model is not one the claim would run (`reason` says why). 422. */
  "IMPLEMENTER_MODEL_NOT_ALLOWED",
  /** The cost limit is above the operator's maximum per turn; the answer carries `maximumCents`. 422. */
  "EXCEEDS_OPERATOR_MAXIMUM",
  /** The platform could not be asked, answered with an error, or answered with something unusable. 503 (never a 502, #690). */
  "IMPLEMENTER_GITHUB_UNAVAILABLE",
] as const;
export type ImplementerErrorCode = (typeof IMPLEMENTER_ERROR_CODES)[number];

/** The HTTP status each code is answered with. */
export const IMPLEMENTER_ERROR_STATUS: Record<
  ImplementerErrorCode,
  400 | 403 | 404 | 409 | 413 | 415 | 422 | 503
> = {
  IMPLEMENTER_REQUEST_INVALID: 400,
  IMPLEMENTER_CROSS_SITE_REQUEST: 403,
  IMPLEMENTER_BODY_TOO_LARGE: 413,
  IMPLEMENTER_CONTENT_TYPE_UNSUPPORTED: 415,
  IMPLEMENTER_REPOSITORY_NOT_FOUND: 404,
  IMPLEMENTER_APP_NOT_INSTALLED: 409,
  IMPLEMENTER_WRITE_NOT_GRANTED: 409,
  IMPLEMENTER_BASE_BRANCH_NOT_FOUND: 404,
  IMPLEMENTER_BRANCH_EXISTS: 409,
  IMPLEMENTER_BRANCH_CONFLICT: 409,
  IMPLEMENTER_REQUEST_REUSED: 409,
  IMPLEMENTER_MODEL_NOT_ALLOWED: 422,
  EXCEEDS_OPERATOR_MAXIMUM: 422,
  IMPLEMENTER_GITHUB_UNAVAILABLE: 503,
};

/** One field of the body that cannot be used. A new branch name names the rule it breaks. */
export type ImplementerIssue = {
  field:
    | "repositoryId"
    | "baseBranch"
    | "branch"
    | "instruction"
    | "model"
    | "costLimitCents"
    | "clientRequestId";
  code: "required" | "invalid" | "too_long" | BranchNameIssue;
};

/** Why a model is not allowed. The picker never lists such a model; a submit that names one is refused with the reason. */
export const MODEL_REFUSAL_REASONS = [
  /** The form of the choice is not the one of the workspace's key: an entry id on its own key, or a provider and model on the operator's. */
  "wrong_key_mode",
  /** The entitlements cannot be read, so it is not known whose key applies. */
  "key_mode_unreadable",
  /** On the operator's key: the id names no entry. */
  "entry_unknown",
  /** On the operator's key: the entry is a draft or retired. */
  "entry_not_released",
  /** On the operator's key: the entry does not serve Dynamic Review. */
  "entry_kind_mismatch",
  /** On the operator's key: the plan does not allow the entry. */
  "entry_not_allowed",
  /** On the operator's key: the entry has no confirmed price, or the catalog cannot describe its model. */
  "entry_unavailable",
  /** On the workspace's own key: the provider cannot be served through the catalog (the registry's two providers are not). */
  "provider_unsupported",
  /** On the workspace's own key: no key is saved for the provider. */
  "no_key",
  /** On the workspace's own key: the catalog does not list the model. */
  "model_not_in_catalog",
] as const;
export type ModelRefusalReason = (typeof MODEL_REFUSAL_REASONS)[number];

/**
 * Why a repository cannot be sent a task although it is listed. The form says a different true thing for each: only the first is
 * cured by approving the new permission.
 */
export const UNWRITABLE_REASONS = [
  /** The installation has not accepted contents write (#749). */
  "write_not_granted",
  /** The installation was removed on the platform. */
  "connection_gone",
  /** The installation is suspended on the platform. */
  "connection_suspended",
  /** The platform rejected the app's own authentication. */
  "app_auth_failed",
  /** The platform refuses the app access to the installation. */
  "scope_refused",
  /** The platform does not let the app reach the repository. */
  "repository_not_accessible",
] as const;
export type UnwritableReason = (typeof UNWRITABLE_REASONS)[number];

export type ImplementerErrorDetails = {
  issues?: readonly ImplementerIssue[];
  reason?: ModelRefusalReason;
  maximumCents?: number;
  /** On `IMPLEMENTER_REQUEST_REUSED`: the run of the task the request id made. */
  runId?: string;
};

export class ImplementerError extends Error {
  readonly code: ImplementerErrorCode;
  readonly issues: readonly ImplementerIssue[];
  readonly reason: ModelRefusalReason | undefined;
  readonly maximumCents: number | undefined;
  readonly runId: string | undefined;
  /** The message names the code's meaning only, never a value from the request or from the platform. */
  readonly safeMessage = true as const;

  constructor(
    code: ImplementerErrorCode,
    message: string,
    details: ImplementerErrorDetails = {},
  ) {
    super(message);
    this.name = "ImplementerError";
    this.code = code;
    this.issues = details.issues ?? [];
    this.reason = details.reason;
    this.maximumCents = details.maximumCents;
    this.runId = details.runId;
  }
}
