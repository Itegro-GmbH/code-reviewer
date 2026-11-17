// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers of the factory's new project (#922): `POST /api/w/:workspace/projects` creates the project of a repository (its one ticket
// source, with the optional GitHub Project that is its board, and the built-in lanes it starts with) and
// `GET /api/w/:workspace/repositories/:repositoryId/boards` lists the boards a project can take, read from GitHub, and (#1038)
// `GET /api/w/:workspace/jira/connections/:connectionId/projects` lists the projects of a Jira site. A project's ticket source may be a Jira
// project (`ticketSource` in the body of the creation): the connection must be the workspace's and the key a project of its site, asked of
// Jira now with one call for that project (never by reading the site's list), after the repository was looked at.
// Collaborators are passed in so the route files wire the real ones and tests wire fakes.
//
// Order, as for the other routes: the user first, then where the request comes from, the content type and size of the body, its JSON,
// the strict check of its shape, the board against the boards GitHub has, then the service. A refusal is `{ "error": <code> }` with a stable
// code from `errors.ts`; a body that cannot be used names every problem in `issues: [{ path, code, message, available }]`. Every answer is
// `Cache-Control: no-store`. The board is never taken from the body as it is: the client names a board, the server reads the repository's
// boards and takes the Status field from them.
import type { SessionUser } from "../auth/access-policy.ts";
import type {
  JiraSourceChoice,
  StoredProject,
  TicketBoard,
} from "../db/repositories/projects-repository.ts";
import { isCrossSite, isJsonRequest } from "../http/request-checks.ts";
import type { BoardInfo } from "../integrations/provider.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import {
  PROJECT_ERROR_STATUS,
  ProjectError,
  type NewProjectIssue,
  type ProjectErrorCode,
} from "./errors.ts";
import { readBoardRequest } from "./board-request.ts";
import { readNewProjectRequest } from "./new-project-request.ts";
import type { ProjectService } from "./service.ts";

/** The body is one small object. */
export const NEW_PROJECT_MAX_BYTES = 4096;

/** What asking GitHub for the boards of a repository came to. */
export type BoardsAnswer =
  | { kind: "boards"; available: boolean; boards: BoardInfo[] }
  | { kind: "repository_not_found" }
  | { kind: "integration_unavailable" }
  | { kind: "failed" };

/** What asking a Jira site for its projects came to (#1038). `connection_not_found` is also what another workspace's connection is. */
export type JiraProjectsAnswer =
  | {
      kind: "projects";
      projects: { key: string; name: string }[];
      /** False when the site has more projects than were read. */
      complete: boolean;
    }
  | { kind: "connection_not_found" }
  | { kind: "connection_broken" }
  | { kind: "unavailable" };

/** The code a lane is reported with when copying them failed in a way no lane has a code for (the project stays). */
export const LANE_COPY_FAILED = "LANE_COPY_FAILED";

/** What copying one built-in lane into the new project came to (`WorkflowService.copyBuiltIn`). */
export type LaneCopy =
  | { key: string; ok: true; workflow: { id: string; name: string } }
  | { key: string; ok: false; code: string };

/** What asking a Jira site for ONE project by its key came to (#1038). `connection_not_found` is also what another workspace's connection is. */
export type JiraProjectAnswer =
  | { kind: "project"; project: { key: string } }
  | { kind: "project_not_found" }
  | { kind: "connection_not_found" }
  | { kind: "connection_broken" }
  | { kind: "unavailable" };

export type NewProjectDependencies = {
  /** The signed in user, or a throw that ends the request. Called first, on every request. */
  requireUser: () => Promise<SessionUser>;
  service: Pick<
    ProjectService,
    "createProject" | "findProject" | "getProject" | "setBoard"
  >;
  boards(repositoryId: string): Promise<BoardsAnswer>;
  /**
   * The projects of the site of a Jira connection of the workspace (#1038). Left out where the deployment has no Jira: a Jira project
   * cannot be named then (`PROJECT_JIRA_UNAVAILABLE`).
   */
  jiraProjects?(connectionId: string): Promise<JiraProjectsAnswer>;
  /**
   * One project of a Jira site by its key (#1038), the check of a creation: one call to Jira, never the list of the site's projects.
   * Left out where the deployment has no Jira: a Jira project cannot be named then (`PROJECT_JIRA_UNAVAILABLE`).
   */
  jiraProject?(
    connectionId: string,
    projectKey: string,
  ): Promise<JiraProjectAnswer>;
  /** The names of the built-in lanes a new project may copy (the workflows module owns them). */
  laneKeys: readonly string[];
  copyLanes(
    user: SessionUser,
    projectId: string,
    keys: readonly string[],
    /** For a Jira project (#1040): the names of the statuses of its workflow, from which the status lane takes its own names. */
    jira?: { statusNames: readonly string[] },
  ): Promise<LaneCopy[]>;
  /**
   * The names of the workflow statuses of a Jira project (#1040), for the status lane's defaults. Empty when they cannot be read: the lane then
   * keeps its default names. Never throws. Left out where the deployment has no Jira.
   */
  jiraStatuses?(connectionId: string, projectKey: string): Promise<string[]>;
};

export type NewProjectHandlers = {
  create(request: Request): Promise<Response>;
  /** `PUT .../projects/:projectId` (#937): sets, changes or clears the board of a project. */
  setBoard(request: Request, projectId: string): Promise<Response>;
  boards(request: Request, repositoryId: string): Promise<Response>;
  /** `GET .../jira/connections/:connectionId/projects` (#1038): the projects of the site of a Jira connection. */
  jiraProjects(request: Request, connectionId: string): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(
  code: ProjectErrorCode,
  issues: readonly NewProjectIssue[] = [],
): Response {
  return Response.json(
    { error: code, ...(issues.length > 0 ? { issues } : {}) },
    { status: PROJECT_ERROR_STATUS[code], headers: NO_STORE },
  );
}

async function readBody(request: Request): Promise<unknown> {
  if (!isJsonRequest(request))
    throw new ProjectError(
      "PROJECT_CONTENT_TYPE_UNSUPPORTED",
      "The body must be application/json.",
    );
  const body = await readLimitedBody(request, NEW_PROJECT_MAX_BYTES);
  if (!body.ok)
    throw new ProjectError(
      "PROJECT_BODY_TOO_LARGE",
      "The request body is too large.",
    );
  try {
    return JSON.parse(body.text);
  } catch {
    throw new ProjectError(
      "PROJECT_REQUEST_INVALID",
      "The body is not valid JSON.",
    );
  }
}

function projectView(project: StoredProject) {
  return {
    id: project.id,
    repositoryId: project.repositoryId,
    active: project.active,
    ticketSource: project.ticketSource,
  };
}

export function createNewProjectHandlers({
  requireUser,
  service,
  boards,
  jiraProjects,
  jiraProject,
  laneKeys,
  copyLanes,
  jiraStatuses,
}: NewProjectDependencies): NewProjectHandlers {
  /** The projects of a Jira connection, or the `ProjectError` that says why there are none to look at. */
  async function jiraProjectsOf(connectionId: string) {
    const answer =
      jiraProjects === undefined
        ? ({ kind: "unavailable" } as const)
        : await jiraProjects(connectionId);
    switch (answer.kind) {
      case "projects":
        return answer;
      case "connection_not_found":
        throw new ProjectError(
          "PROJECT_JIRA_CONNECTION_NOT_FOUND",
          "The workspace has no Jira connection with this id.",
        );
      case "connection_broken":
        throw new ProjectError(
          "PROJECT_JIRA_CONNECTION_BROKEN",
          "The Jira connection is broken: a person has to connect it again.",
        );
      case "unavailable":
        throw new ProjectError(
          "PROJECT_JIRA_UNAVAILABLE",
          "Jira could not be asked for its projects.",
        );
    }
  }

  /**
   * The repository of a creation, looked at before Jira is asked anything: it must be there, available, and have no project that is on.
   * Throws the `ProjectError` the service would have thrown for it (so a creation that cannot succeed costs Jira no call).
   */
  async function checkRepository(repositoryId: string): Promise<void> {
    const entry = await service.findProject(repositoryId);
    if (entry === undefined)
      throw new ProjectError(
        "PROJECT_REPOSITORY_NOT_FOUND",
        "There is no repository with this id.",
      );
    if (!entry.repository.available)
      throw entry.repository.integration.status === "active"
        ? new ProjectError(
            "PROJECT_REPOSITORY_UNAVAILABLE",
            "The repository is no longer available on the platform and cannot be activated.",
          )
        : new ProjectError(
            "PROJECT_INTEGRATION_UNAVAILABLE",
            "The installation of the repository is suspended or removed, so the repository cannot be activated.",
          );
    if (entry.project?.active === true)
      throw new ProjectError(
        "PROJECT_ALREADY_EXISTS",
        "The repository has a project that is switched on already.",
      );
  }

  /**
   * The Jira source a body names, against the project the site has now (one call for that project): the choice, or the refusal that says
   * why not. The refusal names no key of the site. Another workspace's connection is none, so the answer for it is the one for an unknown id.
   */
  async function resolveJira(
    choice: JiraSourceChoice,
  ): Promise<
    { ok: true; choice: JiraSourceChoice } | { ok: false; response: Response }
  > {
    const answer =
      jiraProject === undefined
        ? ({ kind: "unavailable" } as const)
        : await jiraProject(choice.connectionId, choice.projectKey);
    switch (answer.kind) {
      case "project":
        return { ok: true, choice };
      case "project_not_found":
        return {
          ok: false,
          response: refusal("PROJECT_REQUEST_INVALID", [
            {
              path: "ticketSource.projectKey",
              code: "unknown_jira_project",
              message:
                "The Jira site has no project with this key, or the connected account cannot see it.",
            },
          ]),
        };
      case "connection_not_found":
        return {
          ok: false,
          response: refusal("PROJECT_REQUEST_INVALID", [
            {
              path: "ticketSource.connectionId",
              code: "unknown_connection",
              message:
                "The workspace has no Jira connection with this id. Connect Jira in the settings first.",
            },
          ]),
        };
      case "connection_broken":
        throw new ProjectError(
          "PROJECT_JIRA_CONNECTION_BROKEN",
          "The Jira connection is broken: a person has to connect it again.",
        );
      case "unavailable":
        throw new ProjectError(
          "PROJECT_JIRA_UNAVAILABLE",
          "Jira could not be asked for the project.",
        );
    }
  }

  /** The boards of a repository, or the `ProjectError` that says why there are none to look at. */
  async function boardsOf(repositoryId: string) {
    const answer = await boards(repositoryId);
    switch (answer.kind) {
      case "boards":
        return answer;
      case "repository_not_found":
        throw new ProjectError(
          "PROJECT_REPOSITORY_NOT_FOUND",
          "There is no repository with this id.",
        );
      case "integration_unavailable":
        throw new ProjectError(
          "PROJECT_INTEGRATION_UNAVAILABLE",
          "The installation of the repository is suspended or removed.",
        );
      case "failed":
        throw new ProjectError(
          "PROJECT_BOARDS_UNAVAILABLE",
          "GitHub could not be asked for the boards of the repository.",
        );
    }
  }

  /**
   * The board a body names, against the boards GitHub has for the repository: the board with its Status field, or the refusal that says
   * why not (with `available`, the ids that would have been accepted). The Status field is the server's, never the client's.
   */
  async function resolveBoard(
    repositoryId: string,
    projectV2Id: string,
  ): Promise<
    { ok: true; board: TicketBoard } | { ok: false; response: Response }
  > {
    const known = await boardsOf(repositoryId);
    const found = known.boards.find(
      (candidate) => candidate.projectV2Id === projectV2Id,
    );
    if (found === undefined)
      return {
        ok: false,
        response: refusal("PROJECT_REQUEST_INVALID", [
          {
            path: "board.projectV2Id",
            code: known.available ? "unknown_board" : "board_unavailable",
            message: known.available
              ? "The repository has no such board. Choose one of the boards it has."
              : "The boards of this repository cannot be read: the GitHub App may not read Projects (an organization permission the owner of the installation has to grant), or the repository belongs to a user.",
            available: known.boards.map((entry) => entry.projectV2Id),
          },
        ]),
      };
    if (found.statusFieldId === null)
      return {
        ok: false,
        response: refusal("PROJECT_REQUEST_INVALID", [
          {
            path: "board.projectV2Id",
            code: "board_without_status",
            message:
              "The board has no Status field with options, so no ticket can be moved on it. Add one on GitHub or choose another board.",
            available: known.boards
              .filter((entry) => entry.statusFieldId !== null)
              .map((entry) => entry.projectV2Id),
          },
        ]),
      };
    return {
      ok: true,
      board: {
        projectV2Id: found.projectV2Id,
        statusFieldId: found.statusFieldId,
      },
    };
  }

  return {
    async create(request) {
      const user = await requireUser();
      try {
        if (isCrossSite(request))
          throw new ProjectError(
            "PROJECT_CROSS_SITE_REQUEST",
            "The request does not come from this site.",
          );
        const read = readNewProjectRequest(await readBody(request), laneKeys);
        if (!read.ok) return refusal("PROJECT_REQUEST_INVALID", read.issues);
        const { repositoryId, board, lanes, jira } = read.request;

        let ticketBoard: TicketBoard | null = null;
        if (board !== null) {
          const resolved = await resolveBoard(repositoryId, board.projectV2Id);
          if (!resolved.ok) return resolved.response;
          ticketBoard = resolved.board;
        }
        let jiraChoice: JiraSourceChoice | undefined;
        if (jira !== undefined) {
          await checkRepository(repositoryId);
          const resolved = await resolveJira(jira);
          if (!resolved.ok) return resolved.response;
          jiraChoice = resolved.choice;
        }

        const project =
          jiraChoice === undefined
            ? await service.createProject(repositoryId, ticketBoard)
            : await service.createProject(repositoryId, null, jiraChoice);
        // The project is written: whatever goes wrong while the lanes are copied is reported per lane, never as a failure of the creation.
        let copied: LaneCopy[] = [];
        if (lanes.length > 0)
          try {
            copied =
              jiraChoice === undefined
                ? await copyLanes(user, project.id, lanes)
                : await copyLanes(user, project.id, lanes, {
                    statusNames:
                      lanes.includes("issue-to-pr-status") &&
                      jiraStatuses !== undefined
                        ? await jiraStatuses(
                            jiraChoice.connectionId,
                            jiraChoice.projectKey,
                          )
                        : [],
                  });
          } catch (error) {
            console.error(
              "[projects] copying the built-in lanes failed:",
              error instanceof Error ? error.name : "unknown",
            );
            copied = lanes.map((key) => ({
              key,
              ok: false,
              code: LANE_COPY_FAILED,
            }));
          }
        return Response.json(
          {
            project: projectView(project),
            lanes: copied.map((lane) =>
              lane.ok
                ? { key: lane.key, ok: true, workflowId: lane.workflow.id }
                : { key: lane.key, ok: false, code: lane.code },
            ),
          },
          { status: 201, headers: NO_STORE },
        );
      } catch (error) {
        if (error instanceof ProjectError) return refusal(error.code);
        throw error;
      }
    },

    async setBoard(request, projectId) {
      await requireUser();
      try {
        if (isCrossSite(request))
          throw new ProjectError(
            "PROJECT_CROSS_SITE_REQUEST",
            "The request does not come from this site.",
          );
        const read = readBoardRequest(await readBody(request));
        if (!read.ok) return refusal("PROJECT_REQUEST_INVALID", read.issues);
        const project = await service.getProject(projectId);
        if (project === undefined)
          throw new ProjectError(
            "PROJECT_NOT_FOUND",
            "There is no project with this id.",
          );
        let ticketBoard: TicketBoard | null = null;
        if (read.board !== null) {
          const resolved = await resolveBoard(
            project.repositoryId,
            read.board.projectV2Id,
          );
          if (!resolved.ok) return resolved.response;
          ticketBoard = resolved.board;
        }
        const updated = await service.setBoard(project.id, ticketBoard);
        return Response.json(
          { project: projectView(updated) },
          { headers: NO_STORE },
        );
      } catch (error) {
        if (error instanceof ProjectError) return refusal(error.code);
        throw error;
      }
    },

    async jiraProjects(_request, connectionId) {
      await requireUser();
      try {
        const answer = await jiraProjectsOf(connectionId);
        return Response.json(
          {
            complete: answer.complete,
            projects: answer.projects.map(({ key, name }) => ({ key, name })),
          },
          { headers: NO_STORE },
        );
      } catch (error) {
        if (error instanceof ProjectError) return refusal(error.code);
        throw error;
      }
    },

    async boards(_request, repositoryId) {
      await requireUser();
      try {
        const answer = await boardsOf(repositoryId);
        return Response.json(
          {
            available: answer.available,
            boards: answer.boards.map((entry) => ({
              projectV2Id: entry.projectV2Id,
              number: entry.number,
              title: entry.title,
              hasStatusField: entry.statusFieldId !== null,
              statuses: entry.statuses,
            })),
          },
          { headers: NO_STORE },
        );
      } catch (error) {
        if (error instanceof ProjectError) return refusal(error.code);
        throw error;
      }
    },
  };
}
