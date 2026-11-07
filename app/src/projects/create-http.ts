// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers of the factory's new project (#922): `POST /api/w/:workspace/projects` creates the project of a repository (its one ticket
// source, with the optional GitHub Project that is its board, and the built-in lanes it starts with) and
// `GET /api/w/:workspace/repositories/:repositoryId/boards` lists the boards a project can take, read from GitHub. Collaborators are passed
// in so the route files wire the real ones and tests wire fakes.
//
// Order, as for the other routes: the user first, then where the request comes from, the content type and size of the body, its JSON,
// the strict check of its shape, the board against the boards GitHub has, then the service. A refusal is `{ "error": <code> }` with a stable
// code from `errors.ts`; a body that cannot be used names every problem in `issues: [{ path, code, message, available }]`. Every answer is
// `Cache-Control: no-store`. The board is never taken from the body as it is: the client names a board, the server reads the repository's
// boards and takes the Status field from them.
import type { SessionUser } from "../auth/access-policy.ts";
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import { isCrossSite, isJsonRequest } from "../http/request-checks.ts";
import type { BoardInfo } from "../integrations/provider.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import {
  PROJECT_ERROR_STATUS,
  ProjectError,
  type NewProjectIssue,
  type ProjectErrorCode,
} from "./errors.ts";
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

/** The code a lane is reported with when copying them failed in a way no lane has a code for (the project stays). */
export const LANE_COPY_FAILED = "LANE_COPY_FAILED";

/** What copying one built-in lane into the new project came to (`WorkflowService.copyBuiltIn`). */
export type LaneCopy =
  | { key: string; ok: true; workflow: { id: string; name: string } }
  | { key: string; ok: false; code: string };

export type NewProjectDependencies = {
  /** The signed in user, or a throw that ends the request. Called first, on every request. */
  requireUser: () => Promise<SessionUser>;
  service: Pick<ProjectService, "createProject">;
  boards(repositoryId: string): Promise<BoardsAnswer>;
  /** The names of the built-in lanes a new project may copy (the workflows module owns them). */
  laneKeys: readonly string[];
  copyLanes(
    user: SessionUser,
    projectId: string,
    keys: readonly string[],
  ): Promise<LaneCopy[]>;
};

export type NewProjectHandlers = {
  create(request: Request): Promise<Response>;
  boards(request: Request, repositoryId: string): Promise<Response>;
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
  laneKeys,
  copyLanes,
}: NewProjectDependencies): NewProjectHandlers {
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
        const { repositoryId, board, lanes } = read.request;

        let ticketBoard: { projectV2Id: string; statusFieldId: string } | null =
          null;
        if (board !== null) {
          const known = await boardsOf(repositoryId);
          const found = known.boards.find(
            (candidate) => candidate.projectV2Id === board.projectV2Id,
          );
          if (found === undefined)
            return refusal("PROJECT_REQUEST_INVALID", [
              {
                path: "board.projectV2Id",
                code: known.available ? "unknown_board" : "board_unavailable",
                message: known.available
                  ? "The repository has no such board. Choose one of the boards it has."
                  : "The boards of this repository cannot be read: the GitHub App may not read Projects (an organization permission the owner of the installation has to grant), or the repository belongs to a user.",
                available: known.boards.map((entry) => entry.projectV2Id),
              },
            ]);
          if (found.statusFieldId === null)
            return refusal("PROJECT_REQUEST_INVALID", [
              {
                path: "board.projectV2Id",
                code: "board_without_status",
                message:
                  "The board has no Status field with options, so no ticket can be moved on it. Add one on GitHub or choose another board.",
                available: known.boards
                  .filter((entry) => entry.statusFieldId !== null)
                  .map((entry) => entry.projectV2Id),
              },
            ]);
          ticketBoard = {
            projectV2Id: found.projectV2Id,
            statusFieldId: found.statusFieldId,
          };
        }

        const project = await service.createProject(repositoryId, ticketBoard);
        // The project is written: whatever goes wrong while the lanes are copied is reported per lane, never as a failure of the creation.
        let copied: LaneCopy[] = [];
        if (lanes.length > 0)
          try {
            copied = await copyLanes(user, project.id, lanes);
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
