// SPDX-License-Identifier: LicenseRef-Proprietary

// Stable error codes of the workflow routes (#833). The UI translates a code to a sentence, never the other way round. The message
// names the code's meaning only, never a value from the request. `WORKFLOW_INVALID` carries the full list of validation errors
// (`errors`), the same list `POST .../workflows/validate` answers.
import type { Issue } from "./issues.ts";

export const WORKFLOW_ERROR_CODES = [
  /** The body is not usable JSON, or a query value is not a number. */
  "WORKFLOW_REQUEST_INVALID",
  /** The request is from another site. */
  "WORKFLOW_CROSS_SITE_REQUEST",
  /** A body over the bound. */
  "WORKFLOW_BODY_TOO_LARGE",
  /** A body that is not application/json. */
  "WORKFLOW_CONTENT_TYPE_UNSUPPORTED",
  /** No such workflow in this workspace (another workspace's looks the same). */
  "WORKFLOW_NOT_FOUND",
  /** The workflow has no such version. */
  "WORKFLOW_VERSION_NOT_FOUND",
  /** The document does not pass the validator; `errors` lists every problem. */
  "WORKFLOW_INVALID",
  /** The workspace has a workflow of that name already (case ignored). */
  "WORKFLOW_NAME_TAKEN",
  /** The workspace holds the maximum number of workflows. */
  "WORKFLOW_LIMIT_REACHED",
  /** The workflow holds the maximum number of versions. */
  "WORKFLOW_VERSION_LIMIT_REACHED",
  /** `expectedVersion` is not the current version: somebody saved in between. `current` says which is. */
  "WORKFLOW_VERSION_CONFLICT",
] as const;
export type WorkflowErrorCode = (typeof WORKFLOW_ERROR_CODES)[number];

export const WORKFLOW_ERROR_STATUS: Record<WorkflowErrorCode, number> = {
  WORKFLOW_REQUEST_INVALID: 400,
  WORKFLOW_CROSS_SITE_REQUEST: 403,
  WORKFLOW_BODY_TOO_LARGE: 413,
  WORKFLOW_CONTENT_TYPE_UNSUPPORTED: 415,
  WORKFLOW_NOT_FOUND: 404,
  WORKFLOW_VERSION_NOT_FOUND: 404,
  WORKFLOW_INVALID: 422,
  WORKFLOW_NAME_TAKEN: 409,
  WORKFLOW_LIMIT_REACHED: 409,
  WORKFLOW_VERSION_LIMIT_REACHED: 409,
  WORKFLOW_VERSION_CONFLICT: 409,
};

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  /** On `WORKFLOW_INVALID`: every problem of the document. */
  readonly errors: readonly Issue[];
  /** On `WORKFLOW_LIMIT_REACHED` and `WORKFLOW_VERSION_LIMIT_REACHED`: how many may be held. */
  readonly maximum: number | undefined;
  /** On `WORKFLOW_VERSION_CONFLICT`: the version that is current. */
  readonly current: number | undefined;
  readonly safeMessage = true as const;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    details: {
      errors?: readonly Issue[];
      maximum?: number;
      current?: number;
    } = {},
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.errors = details.errors ?? [];
    this.maximum = details.maximum;
    this.current = details.current;
  }
}
