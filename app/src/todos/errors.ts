// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable codes of the ToDo routes (#924). The UI translates a code to copy; nothing else branches on a message.
export const TODOS_ERROR_CODES = [
  /** `/projects/:id/todos`: the workspace has no project with this id. */
  "TODOS_PROJECT_NOT_FOUND",
  /** The body of a review is not one the route knows (`path`, `code`, `message`, `available` of every problem are in `issues`). */
  "TODOS_REQUEST_INVALID",
  "TODOS_CONTENT_TYPE_UNSUPPORTED",
  "TODOS_BODY_TOO_LARGE",
  /** The request does not come from this site (cross-site `Sec-Fetch-Site` or a foreign `Origin`). */
  "TODOS_CROSS_SITE_REQUEST",
  /** The pull request is not one a review is asked for from this person or the members of the workspace, or it is not a pull request of a lane. */
  "TODOS_REVIEW_NOT_REQUESTED",
  /** The repository has no active GitHub connection, or its App may not review. */
  "TODOS_GITHUB_UNAVAILABLE",
  /** GitHub could not be asked or refused; nothing was posted that can be told apart, and asking again is safe. */
  "TODOS_REVIEW_FAILED",
] as const;
export type TodosErrorCode = (typeof TODOS_ERROR_CODES)[number];

export const TODOS_ERROR_STATUS: Record<TodosErrorCode, number> = {
  TODOS_PROJECT_NOT_FOUND: 404,
  TODOS_REQUEST_INVALID: 400,
  TODOS_CONTENT_TYPE_UNSUPPORTED: 415,
  TODOS_BODY_TOO_LARGE: 413,
  TODOS_CROSS_SITE_REQUEST: 403,
  TODOS_REVIEW_NOT_REQUESTED: 404,
  TODOS_GITHUB_UNAVAILABLE: 409,
  // Never a 502: a proxy swaps its body (#690).
  TODOS_REVIEW_FAILED: 503,
};

/** One problem of a request body. `available` lists the values that would have been accepted, for a value out of a closed set. */
export type TodosRequestIssue = {
  path: string;
  code: "required" | "invalid" | "too_long";
  message: string;
  available?: readonly string[];
};

export class TodosError extends Error {
  readonly safeMessage = true as const;
  readonly code: TodosErrorCode;
  readonly issues: readonly TodosRequestIssue[];

  constructor(
    code: TodosErrorCode,
    message: string,
    issues: readonly TodosRequestIssue[] = [],
  ) {
    super(message);
    this.name = "TodosError";
    this.code = code;
    this.issues = issues;
  }
}
