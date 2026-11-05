// SPDX-License-Identifier: LicenseRef-Proprietary

// Stable error codes of the environment routes (#818). The UI translates a code to a sentence, never the other way round. The
// message names the code's meaning only, never a value from the request.
export const ENVIRONMENT_ERROR_CODES = [
  /** The body is unusable; `issues` names the fields. */
  "ENVIRONMENT_REQUEST_INVALID",
  /** The request is from another site. */
  "ENVIRONMENT_CROSS_SITE_REQUEST",
  /** A body over the bound. */
  "ENVIRONMENT_BODY_TOO_LARGE",
  /** A body that is not application/json. */
  "ENVIRONMENT_CONTENT_TYPE_UNSUPPORTED",
  /** No such environment in this workspace (another workspace's looks the same). */
  "ENVIRONMENT_NOT_FOUND",
  /** The workspace has an environment of that name already (case ignored). */
  "ENVIRONMENT_NAME_TAKEN",
  /** The workspace holds the maximum number of environments. */
  "ENVIRONMENT_LIMIT_REACHED",
] as const;
export type EnvironmentErrorCode = (typeof ENVIRONMENT_ERROR_CODES)[number];

export const ENVIRONMENT_ERROR_STATUS: Record<EnvironmentErrorCode, number> = {
  ENVIRONMENT_REQUEST_INVALID: 400,
  ENVIRONMENT_CROSS_SITE_REQUEST: 403,
  ENVIRONMENT_BODY_TOO_LARGE: 413,
  ENVIRONMENT_CONTENT_TYPE_UNSUPPORTED: 415,
  ENVIRONMENT_NOT_FOUND: 404,
  ENVIRONMENT_NAME_TAKEN: 409,
  ENVIRONMENT_LIMIT_REACHED: 409,
};

export const ENVIRONMENT_ISSUE_FIELDS = [
  "name",
  "vcpus",
  "setupScript",
  /** #745, step 7: the rule for the agent's network (its mode, or the shape of the body's `network`). */
  "network",
  /** #745, step 7: the hosts of a list. */
  "networkHosts",
  /** #854: `hosted` or `runner`. */
  "kind",
  /** #854: the labels of a runner environment, or the `labels[i]` that is wrong. */
  "labels",
] as const;
export const ENVIRONMENT_ISSUE_CODES = [
  "required",
  "invalid",
  "too_long",
] as const;
/** A broken field of the body. The code never holds the value. */
export type EnvironmentIssue = {
  field: (typeof ENVIRONMENT_ISSUE_FIELDS)[number];
  code: (typeof ENVIRONMENT_ISSUE_CODES)[number];
};

export class EnvironmentError extends Error {
  readonly code: EnvironmentErrorCode;
  readonly issues: readonly EnvironmentIssue[];
  /** On `ENVIRONMENT_LIMIT_REACHED`: how many a workspace may hold. */
  readonly maximum: number | undefined;
  readonly safeMessage = true as const;

  constructor(
    code: EnvironmentErrorCode,
    message: string,
    details: { issues?: readonly EnvironmentIssue[]; maximum?: number } = {},
  ) {
    super(message);
    this.name = "EnvironmentError";
    this.code = code;
    this.issues = details.issues ?? [];
    this.maximum = details.maximum;
  }
}
