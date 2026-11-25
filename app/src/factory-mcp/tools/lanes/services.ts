// SPDX-License-Identifier: LicenseRef-Proprietary

// The services of the lane tools (#1145): the SAME one the routes below `/api/w/:workspace/workflows` build, for the workspace of the token.
// A lane is a "workflow" in the app's code and routes; the tools say lane, as the web app does.
import type { WorkflowService } from "../../../workflows/service.ts";
import {
  WorkflowError,
  type WorkflowErrorCode,
} from "../../../workflows/errors.ts";
import { workflowServiceFor } from "../../../workflows/shared.ts";
import { ToolError, type ToolErrorCode } from "../errors.ts";
import type { ServiceFactory } from "../services.ts";

/** The lane service the routes use (validation against the workspace's runners, profiles, MCP servers and models included). */
export const lanesService: ServiceFactory<WorkflowService> = ({ access }) =>
  workflowServiceFor(access.workspace.id);

const CODE_OF: Record<WorkflowErrorCode, ToolErrorCode> = {
  WORKFLOW_REQUEST_INVALID: "invalid_input",
  WORKFLOW_CROSS_SITE_REQUEST: "internal_error",
  WORKFLOW_BODY_TOO_LARGE: "invalid_input",
  WORKFLOW_CONTENT_TYPE_UNSUPPORTED: "internal_error",
  WORKFLOW_NOT_FOUND: "not_found",
  WORKFLOW_VERSION_NOT_FOUND: "not_found",
  WORKFLOW_INVALID: "invalid_input",
  WORKFLOW_NAME_TAKEN: "conflict",
  WORKFLOW_LIMIT_REACHED: "limit_reached",
  WORKFLOW_ARCHIVE_LIMIT_REACHED: "limit_reached",
  WORKFLOW_VERSION_LIMIT_REACHED: "limit_reached",
  WORKFLOW_VERSION_CONFLICT: "conflict",
  WORKFLOW_ARCHIVED: "conflict",
  WORKFLOW_PROJECT_REQUIRED: "invalid_input",
  WORKFLOW_PROJECT_NOT_FOUND: "not_found",
  WORKFLOW_PROJECT_INACTIVE: "conflict",
  WORKFLOW_CHANGE_DESCRIPTION_REQUIRED: "invalid_input",
};

/**
 * Runs a call of the lane service and turns its own refusal into the tool's code: a document that does not pass is `invalid_input` with
 * EVERY problem in `errors` (path, code, message, the names that were available), a stale `expectedVersion` is `conflict` with the version that
 * is `current`, a full workspace is `limit_reached` with the `maximum`. The service's code is kept in `details.code`.
 */
export async function laneService<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    const code = CODE_OF[error.code];
    // A code that means a bug of this server (the engine's own checks of the request we built) is never shown.
    if (code === "internal_error") throw error;
    throw new ToolError(code, error.message, {
      code: error.code,
      ...(error.errors.length > 0 ? { errors: error.errors } : {}),
      ...(error.code === "WORKFLOW_INVALID"
        ? { truncated: error.truncated ?? false }
        : {}),
      ...(error.maximum === undefined ? {} : { maximum: error.maximum }),
      ...(error.current === undefined ? {} : { current: error.current }),
      ...(error.issues.length > 0 ? { issues: error.issues } : {}),
    });
  }
}

/** The page of a lane in the web app: an address a person can open. */
export function laneUrl(
  context: { environment: { baseUrl: string }; workspace: { slug: string } },
  laneId: string,
): string {
  return `${context.environment.baseUrl.replace(/\/+$/, "")}/w/${context.workspace.slug}/workflows/${laneId}`;
}
