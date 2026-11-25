// SPDX-License-Identifier: LicenseRef-Proprietary

// The services of the project tools (#1145): the SAME ones the routes `POST /projects`, `PUT /projects/:id` and `PUT /repositories/:id/project`
// build, for the workspace of the token. Creating and changing a project go through the route's own handlers (`createNewProjectHandlers`), so the
// checks of the body, of the board against GitHub and of a Jira source are the app's and not a copy.
import { after } from "next/server";
import {
  jiraProjectFor,
  jiraProjectsFor,
  jiraStatusNamesFor,
} from "../../../jira/source-shared.ts";
import {
  afterJiraDeactivation,
  withJiraActivation,
} from "../../../jira/webhook-registrar-shared.ts";
import {
  createNewProjectHandlers,
  type NewProjectHandlers,
} from "../../../projects/create-http.ts";
import { boardsFor } from "../../../projects/create-shared.ts";
import {
  PROJECT_ERROR_CODES,
  ProjectError,
  type ProjectErrorCode,
} from "../../../projects/errors.ts";
import type { ProjectService } from "../../../projects/service.ts";
import { projectServiceFor } from "../../../projects/shared.ts";
import { firstSyncAfterActivation } from "../../../tracker/first-sync.ts";
import { trackerServiceFor } from "../../../tracker/shared.ts";
import {
  BUILT_IN_LANE_KEYS,
  isBuiltInLaneKey,
  laneStatusesFromNames,
} from "../../../workflows/built-in-lanes.ts";
import { workflowServiceFor } from "../../../workflows/shared.ts";
import { ToolError, type ToolErrorCode } from "../errors.ts";
import type { ServiceFactory } from "../services.ts";

/** How long the first sync may read before it stops and waits for the next "Resync" (as the routes). */
const FIRST_SYNC_BUDGET_MS = 20_000;

/** The project service, wired as the route that switches a project on or off wires it (Jira's webhook, the first sync of the tickets). */
export const projectsService: ServiceFactory<ProjectService> = ({ access }) =>
  projectServiceFor(
    access.workspace.id,
    withJiraActivation(
      access.workspace.id,
      firstSyncAfterActivation({
        sync: (repositoryId, options) =>
          trackerServiceFor(access.workspace.id).sync(repositoryId, options),
        schedule: (work) => after(work),
        budgetMs: FIRST_SYNC_BUDGET_MS,
      }),
    ),
    afterJiraDeactivation(access.workspace.id),
  );

/** The handlers of `POST /projects` and `PUT /projects/:id`, wired as those routes wire them. */
export const newProjectHandlers: ServiceFactory<NewProjectHandlers> = (scope) =>
  createNewProjectHandlers({
    requireUser: () => Promise.resolve(scope.access.user),
    service: projectsService(scope),
    boards: boardsFor(scope.access.workspace.id),
    jiraProjects: jiraProjectsFor(scope.access.workspace.id),
    jiraProject: jiraProjectFor(scope.access.workspace.id),
    jiraStatuses: jiraStatusNamesFor(scope.access.workspace.id),
    laneKeys: BUILT_IN_LANE_KEYS,
    copyLanes: (user, projectId, keys, jira) =>
      workflowServiceFor(scope.access.workspace.id).copyBuiltIn(
        user,
        projectId,
        keys.filter(isBuiltInLaneKey),
        jira === undefined
          ? undefined
          : laneStatusesFromNames(jira.statusNames),
        jira === undefined ? undefined : "jira",
      ),
  });

const CODE_OF: Record<ProjectErrorCode, ToolErrorCode> = {
  PROJECT_REQUEST_INVALID: "invalid_input",
  PROJECT_CROSS_SITE_REQUEST: "internal_error",
  PROJECT_BODY_TOO_LARGE: "invalid_input",
  PROJECT_CONTENT_TYPE_UNSUPPORTED: "internal_error",
  PROJECT_REPOSITORY_NOT_FOUND: "not_found",
  PROJECT_REPOSITORY_UNAVAILABLE: "conflict",
  PROJECT_INTEGRATION_UNAVAILABLE: "conflict",
  PROJECT_ALREADY_EXISTS: "conflict",
  PROJECT_BOARDS_UNAVAILABLE: "unavailable",
  PROJECT_NOT_FOUND: "not_found",
  PROJECT_JIRA_CONNECTION_NOT_FOUND: "not_found",
  PROJECT_JIRA_CONNECTION_BROKEN: "conflict",
  PROJECT_JIRA_UNAVAILABLE: "unavailable",
  PROJECT_BOARD_NOT_SUPPORTED: "conflict",
};

const isProjectErrorCode = (value: unknown): value is ProjectErrorCode =>
  (PROJECT_ERROR_CODES as readonly unknown[]).includes(value);

/** Turns a refusal of the project service into the tool's code; the service's code stays in `details.code`. */
export function projectToolError(
  error: ProjectError,
  issues?: unknown,
): ToolError | ProjectError {
  const code = CODE_OF[error.code];
  if (code === "internal_error") return error;
  return new ToolError(code, error.message, {
    code: error.code,
    ...(Array.isArray(issues) && issues.length > 0 ? { issues } : {}),
  });
}

export async function projectService<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProjectError) throw projectToolError(error);
    throw error;
  }
}

/**
 * Calls a handler of the routes with a request made here (JSON body, no browser headers) and reads its answer: the JSON of a success, or the
 * route's refusal as a `ToolError` (the code, and `issues`: every problem of the body with the names that would have been accepted).
 */
export async function callHandler(
  handler: (request: Request) => Promise<Response>,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await handler(
    new Request("https://factory.invalid/factory-mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const answer = (await response.json()) as Record<string, unknown>;
  if (response.ok) return answer;
  if (isProjectErrorCode(answer.error)) {
    const failure = projectToolError(
      new ProjectError(answer.error, messageOf(answer.error)),
      answer.issues,
    );
    throw failure;
  }
  throw new Error(`the project handler answered ${response.status}`);
}

const MESSAGE: Partial<Record<ProjectErrorCode, string>> = {
  PROJECT_REQUEST_INVALID:
    "The request does not pass the project rules; `issues` lists every problem and the names that would have been accepted.",
  PROJECT_BODY_TOO_LARGE: "The request is too large.",
  PROJECT_REPOSITORY_NOT_FOUND: "There is no repository with this id.",
  PROJECT_REPOSITORY_UNAVAILABLE:
    "The repository is no longer available on the platform and cannot be activated.",
  PROJECT_INTEGRATION_UNAVAILABLE:
    "The installation of the repository is suspended or removed.",
  PROJECT_ALREADY_EXISTS:
    "The repository has a project that is switched on already.",
  PROJECT_BOARDS_UNAVAILABLE:
    "GitHub could not be asked for the boards of the repository.",
  PROJECT_NOT_FOUND: "There is no project with this id.",
  PROJECT_JIRA_CONNECTION_NOT_FOUND:
    "The workspace has no Jira connection with this id.",
  PROJECT_JIRA_CONNECTION_BROKEN:
    "The Jira connection is broken: a person has to connect it again.",
  PROJECT_JIRA_UNAVAILABLE: "Jira could not be asked.",
  PROJECT_BOARD_NOT_SUPPORTED:
    "A project whose tickets are a Jira project's has no board.",
};
const messageOf = (code: ProjectErrorCode): string =>
  MESSAGE[code] ?? "The project request was refused.";
