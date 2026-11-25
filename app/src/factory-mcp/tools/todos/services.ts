// SPDX-License-Identifier: LicenseRef-Proprietary

// The services of the ToDo and ticket tools (#1146): the same ones the routes `/todos`, `/todos/reviews`, `/projects/:id/issues`,
// `/repositories/:id/issues/sync`, `/repositories/:id/pull-requests` and `/runs` build, for the workspace of the token.
import {
  TrackerError,
  type TrackerErrorCode,
} from "../../../tracker/errors.ts";
import { trackerServiceFor } from "../../../tracker/shared.ts";
import type { TrackerService } from "../../../tracker/service.ts";
import { TodosError, type TodosErrorCode } from "../../../todos/errors.ts";
import type { ReviewActions } from "../../../todos/review.ts";
import { reviewActionsFor, todosServiceFor } from "../../../todos/shared.ts";
import type { TodosService } from "../../../todos/service.ts";
import { projectServiceFor } from "../../../projects/shared.ts";
import type { ProjectService } from "../../../projects/service.ts";
import {
  ManualReviewError,
  type ManualReviewErrorCode,
} from "../../../manual-reviews/errors.ts";
import type { ManualReviewService } from "../../../manual-reviews/service.ts";
import { manualReviewServiceFor } from "../../../manual-reviews/shared.ts";
import type { RunsService } from "../../../runs/runs-service.ts";
import { runsServiceFor } from "../../../runs/shared.ts";
import { ToolError, type ToolErrorCode } from "../errors.ts";
import type { ToolContext } from "../context.ts";
import type { ServiceFactory } from "../services.ts";

export const todosService: ServiceFactory<TodosService> = ({ access }) =>
  todosServiceFor(access.workspace.id);

export const reviewActions: ServiceFactory<ReviewActions> = ({ access }) =>
  reviewActionsFor(access.workspace.id);

export const trackerService: ServiceFactory<TrackerService> = ({ access }) =>
  trackerServiceFor(access.workspace.id);

export const projectService: ServiceFactory<ProjectService> = ({ access }) =>
  projectServiceFor(access.workspace.id);

export const manualReviewService: ServiceFactory<ManualReviewService> = ({
  access,
}) => manualReviewServiceFor(access.workspace.id);

export const reviewRunsService: ServiceFactory<RunsService> = ({ access }) =>
  runsServiceFor(access.workspace.id);

/**
 * The person a ToDo is for. A person who signed in without GitHub has no login; a token's person never has one here (the AI app acts as a
 * session user), so the reviews asked of a login are not "yours": the members' reviews are, which any member may answer.
 */
export const VIEWER = { githubLogin: null } as const;

const TODOS_CODE: Record<TodosErrorCode, ToolErrorCode> = {
  TODOS_PROJECT_NOT_FOUND: "not_found",
  TODOS_REQUEST_INVALID: "invalid_input",
  TODOS_CONTENT_TYPE_UNSUPPORTED: "internal_error",
  TODOS_BODY_TOO_LARGE: "invalid_input",
  TODOS_CROSS_SITE_REQUEST: "internal_error",
  TODOS_REVIEW_NOT_REQUESTED: "not_found",
  TODOS_GITHUB_UNAVAILABLE: "unavailable",
  TODOS_REVIEW_FAILED: "unavailable",
};

const TRACKER_CODE: Record<TrackerErrorCode, ToolErrorCode> = {
  TRACKER_REPOSITORY_NOT_FOUND: "not_found",
  TRACKER_PROJECT_NOT_FOUND: "not_found",
  TRACKER_PROJECT_NOT_ACTIVE: "conflict",
  TRACKER_INTEGRATION_UNAVAILABLE: "unavailable",
  TRACKER_SOURCE_NOT_MIRRORED: "conflict",
  TRACKER_REQUEST_INVALID: "invalid_input",
  TRACKER_CROSS_SITE_REQUEST: "internal_error",
  TRACKER_SYNC_FAILED: "unavailable",
};

const MANUAL_REVIEW_CODE: Record<ManualReviewErrorCode, ToolErrorCode> = {
  MANUAL_REVIEW_REQUEST_INVALID: "invalid_input",
  MANUAL_REVIEW_CROSS_SITE_REQUEST: "internal_error",
  MANUAL_REVIEW_BODY_TOO_LARGE: "invalid_input",
  MANUAL_REVIEW_CONTENT_TYPE_UNSUPPORTED: "internal_error",
  MANUAL_REVIEW_PROJECT_NOT_FOUND: "not_found",
  MANUAL_REVIEW_PULL_REQUEST_NOT_FOUND: "not_found",
  MANUAL_REVIEW_PULL_REQUEST_NOT_OPEN: "conflict",
  MANUAL_REVIEW_COMMAND_NOT_ALLOWED: "conflict",
  MANUAL_REVIEW_APP_NOT_INSTALLED: "unavailable",
  MANUAL_REVIEW_GITHUB_UNAVAILABLE: "unavailable",
};

function refusal(
  code: ToolErrorCode,
  serviceCode: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolError | undefined {
  // A code that means a bug of this server is never shown: the caller rethrows the original.
  if (code === "internal_error") return undefined;
  return new ToolError(code, message, { code: serviceCode, ...extra });
}

/** Runs a call of the ToDo or review service and maps its own refusal to the tool's code (`details.code` keeps the service's). */
export async function todoService<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof TodosError)) throw error;
    throw (
      refusal(
        TODOS_CODE[error.code],
        error.code,
        error.message,
        error.issues.length > 0 ? { issues: error.issues } : {},
      ) ?? error
    );
  }
}

/** The same for the ticket mirror. */
export async function trackerCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof TrackerError)) throw error;
    throw refusal(TRACKER_CODE[error.code], error.code, error.message) ?? error;
  }
}

/** The same for the pull request list. */
export async function manualReviewCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ManualReviewError)) throw error;
    throw (
      refusal(
        MANUAL_REVIEW_CODE[error.code],
        error.code,
        error.message,
        error.issues.length > 0 ? { issues: error.issues } : {},
      ) ?? error
    );
  }
}

/** The repository of a project of this workspace (its tickets', and so the one its pull requests are read from), or a `not_found`. */
export async function projectOf(
  context: ToolContext,
  projectId: string,
): Promise<{ id: string; repositoryId: string; ticketRepositoryId: string }> {
  const project = await context.services
    .use(projectService)
    .getProject(projectId);
  if (project === undefined)
    throw new ToolError(
      "not_found",
      "There is no such project in this workspace.",
    );
  return {
    id: project.id,
    repositoryId: project.repositoryId,
    ticketRepositoryId: project.ticketSource.repositoryId,
  };
}
