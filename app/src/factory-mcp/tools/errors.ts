// SPDX-License-Identifier: LicenseRef-Proprietary

// The one shape of a tool's failure (epic #1143: "errors are uniform"). A tool never returns free text for a failure and never lets an
// exception reach the client: it throws a `ToolError` with one of these stable codes, and the registry turns it into the MCP result
// `{ isError: true }` whose text and structured content are `{ "error": <code>, "message": <sentence>, ...details }`. A client branches on
// the code. A service's own error (a lane that does not validate, a full workspace) is mapped to one of these codes by the tool, with the
// service's code and details in `details`.

export const TOOL_ERROR_CODES = [
  /** The arguments do not fit the tool's input schema, or the service refused them as invalid (a lane document with errors). */
  "invalid_input",
  /** The token's scope is not enough for this tool (`factory:control` is needed). */
  "insufficient_scope",
  /** The person's role in the workspace does not allow this (a Member saving a lane). */
  "forbidden",
  /** The thing is not there in this workspace (another workspace's id answers the same). */
  "not_found",
  /** The thing changed since it was read, or its state does not allow this (a stale revision, a finished run). */
  "conflict",
  /** A limit of the workspace or of the factory is reached (budget, maximum number of lanes). */
  "limit_reached",
  /** Something the tool needs is not available right now; trying again later can work. */
  "unavailable",
  /** A bug: nothing about it is told to the client, the server's log has the details. */
  "internal_error",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  /** Machine readable extras of the failure (the validator's error list, the current revision). Never a secret. */
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ToolErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

export type ToolFailure = {
  error: ToolErrorCode;
  message: string;
} & Record<string, unknown>;

export function failureOf(error: ToolError): ToolFailure {
  return { ...(error.details ?? {}), error: error.code, message: error.message };
}
