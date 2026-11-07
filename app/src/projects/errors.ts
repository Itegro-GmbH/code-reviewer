// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable error codes of the project service. A caller (the route, a test) branches on `code`,
// never on the message; the UI translates codes to copy.
export const PROJECT_ERROR_CODES = [
  /** The request is not usable: a malformed repository id, or a body that is not `{ "active": boolean }`. 400. */
  "PROJECT_REQUEST_INVALID",
  /** The request does not come from this site (cross-site `Sec-Fetch-Site` or a foreign `Origin`). 403. */
  "PROJECT_CROSS_SITE_REQUEST",
  /** The body is larger than the limit. 413. */
  "PROJECT_BODY_TOO_LARGE",
  /** The content type is not `application/json`. 415. */
  "PROJECT_CONTENT_TYPE_UNSUPPORTED",
  /** No repository has this id. */
  "PROJECT_REPOSITORY_NOT_FOUND",
  /** The platform no longer lists the repository (removed from the installation); it cannot be activated. 409. */
  "PROJECT_REPOSITORY_UNAVAILABLE",
  /** The repository's installation is suspended or removed (integration `disabled`); it cannot be activated. 409. */
  "PROJECT_INTEGRATION_UNAVAILABLE",
  /** Creating a project (#922): the repository has a project that is switched on already. 409. */
  "PROJECT_ALREADY_EXISTS",
  /** Creating a project (#922): the platform could not be asked for the boards of the repository. 503. */
  "PROJECT_BOARDS_UNAVAILABLE",
] as const;
export type ProjectErrorCode = (typeof PROJECT_ERROR_CODES)[number];

/** The HTTP status each code is answered with. */
export const PROJECT_ERROR_STATUS: Record<
  ProjectErrorCode,
  400 | 403 | 404 | 409 | 413 | 415 | 503
> = {
  PROJECT_REQUEST_INVALID: 400,
  PROJECT_CROSS_SITE_REQUEST: 403,
  PROJECT_BODY_TOO_LARGE: 413,
  PROJECT_CONTENT_TYPE_UNSUPPORTED: 415,
  PROJECT_REPOSITORY_NOT_FOUND: 404,
  PROJECT_REPOSITORY_UNAVAILABLE: 409,
  PROJECT_INTEGRATION_UNAVAILABLE: 409,
  PROJECT_ALREADY_EXISTS: 409,
  // Never a 502: a proxy swaps its body (#690).
  PROJECT_BOARDS_UNAVAILABLE: 503,
};

/** A value of the body of a new project that cannot be used (#922), with the values that would have been accepted. */
export type NewProjectIssue = {
  path: string;
  code:
    | "missing_field"
    | "wrong_type"
    | "unknown_field"
    | "invalid_value"
    | "unknown_lane"
    | "duplicate_lane"
    | "unknown_board"
    | "board_without_status"
    | "board_unavailable";
  message: string;
  available?: string[];
};

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;
  /** The message names the code's meaning only, never a value from the request. */
  readonly safeMessage = true as const;

  constructor(code: ProjectErrorCode, message: string) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
  }
}
