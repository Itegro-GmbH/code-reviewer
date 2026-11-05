// SPDX-License-Identifier: LicenseRef-Proprietary

// Stable error codes of the profile routes (#843). The UI translates a code to a sentence, never the other way round. The message
// names the code's meaning only, never a value from the request. `PROFILE_INVALID` carries the list of problems (`errors`) and whether
// it is cut (`truncated`), the same answer `POST .../profiles/validate` gives.
import type { Issue, IssueCode } from "../workflows/issues.ts";

/** The problems only the world can find (the validator of the body cannot): they sit next to the codes of the workflow validator. */
export const PROFILE_ONLY_ISSUE_CODES = [
  /** The model is not one the claim would run for this workspace (`reason` in the message, from `GET .../implementer/models`). */
  "model_not_allowed",
  /** The cost limit is above the operator's maximum per turn. */
  "cost_limit_above_maximum",
] as const;

export type ProfileIssueCode =
  IssueCode | (typeof PROFILE_ONLY_ISSUE_CODES)[number];
export type ProfileIssue = Omit<Issue, "code"> & { code: ProfileIssueCode };

export const PROFILE_ERROR_CODES = [
  /** The body is not usable JSON, or a query value is not a number. */
  "PROFILE_REQUEST_INVALID",
  /** The request is from another site. */
  "PROFILE_CROSS_SITE_REQUEST",
  /** A body over the bound. */
  "PROFILE_BODY_TOO_LARGE",
  /** A body that is not application/json. */
  "PROFILE_CONTENT_TYPE_UNSUPPORTED",
  /** No such profile in this workspace (another workspace's looks the same). */
  "PROFILE_NOT_FOUND",
  /** The profile has no such version. */
  "PROFILE_VERSION_NOT_FOUND",
  /** The body does not pass the validator; `errors` lists every problem. */
  "PROFILE_INVALID",
  /** The workspace has a profile of that name already. */
  "PROFILE_NAME_TAKEN",
  /** A new version carries another name than the profile has: the name of a profile never changes. */
  "PROFILE_NAME_CHANGED",
  /** The workspace holds the maximum number of profiles. */
  "PROFILE_LIMIT_REACHED",
  /** The workspace holds the maximum number of archived profiles: one more cannot be archived. */
  "PROFILE_ARCHIVE_LIMIT_REACHED",
  /** The profile holds the maximum number of versions. */
  "PROFILE_VERSION_LIMIT_REACHED",
  /** `expectedVersion` is not the current version: somebody saved in between. `current` says which is. */
  "PROFILE_VERSION_CONFLICT",
  /** The profile is archived and takes no new version. */
  "PROFILE_ARCHIVED",
] as const;
export type ProfileErrorCode = (typeof PROFILE_ERROR_CODES)[number];

export const PROFILE_ERROR_STATUS: Record<ProfileErrorCode, number> = {
  PROFILE_REQUEST_INVALID: 400,
  PROFILE_CROSS_SITE_REQUEST: 403,
  PROFILE_BODY_TOO_LARGE: 413,
  PROFILE_CONTENT_TYPE_UNSUPPORTED: 415,
  PROFILE_NOT_FOUND: 404,
  PROFILE_VERSION_NOT_FOUND: 404,
  PROFILE_INVALID: 422,
  PROFILE_NAME_TAKEN: 409,
  PROFILE_NAME_CHANGED: 422,
  PROFILE_LIMIT_REACHED: 409,
  PROFILE_ARCHIVE_LIMIT_REACHED: 409,
  PROFILE_VERSION_LIMIT_REACHED: 409,
  PROFILE_VERSION_CONFLICT: 409,
  PROFILE_ARCHIVED: 409,
};

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  /** On `PROFILE_INVALID` (and `PROFILE_NAME_CHANGED`): the problems of the body. */
  readonly errors: readonly ProfileIssue[];
  /** On `PROFILE_INVALID`: there are more problems than `errors` lists. */
  readonly truncated: boolean | undefined;
  /** On `PROFILE_LIMIT_REACHED`, `PROFILE_ARCHIVE_LIMIT_REACHED` and `PROFILE_VERSION_LIMIT_REACHED`: how many may be held. */
  readonly maximum: number | undefined;
  /** On `PROFILE_VERSION_CONFLICT`: the version that is current. */
  readonly current: number | undefined;
  readonly safeMessage = true as const;

  constructor(
    code: ProfileErrorCode,
    message: string,
    details: {
      errors?: readonly ProfileIssue[];
      truncated?: boolean;
      maximum?: number;
      current?: number;
    } = {},
  ) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    this.errors = details.errors ?? [];
    this.truncated = details.truncated;
    this.maximum = details.maximum;
    this.current = details.current;
  }
}
