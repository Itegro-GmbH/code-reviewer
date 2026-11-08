// SPDX-License-Identifier: LicenseRef-Proprietary

// `PUT /api/w/:workspace/projects/:projectId` (#937), the handler: the user first, then where the request comes from and what it carries, the
// strict check of the body, the project of the workspace, the board against the boards GitHub has, then the service. The collaborators are fakes.
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import type { BoardInfo } from "../integrations/provider.ts";
import {
  createNewProjectHandlers,
  type BoardsAnswer,
  type NewProjectDependencies,
} from "./create-http.ts";
import { ProjectError } from "./errors.ts";

const USER = { id: "user-1", githubLogin: "octocat" } as unknown as SessionUser;

const BOARDS: BoardInfo[] = [
  {
    projectV2Id: "PVT_board1",
    number: 1,
    title: "Roadmap",
    statusFieldId: "PVTSSF_1",
    statuses: ["Todo", "Done"],
  },
  {
    projectV2Id: "PVT_board2",
    number: 2,
    title: "Loose",
    statusFieldId: null,
    statuses: [],
  },
];

function projectOf(
  board: StoredProject["ticketSource"]["board"],
): StoredProject {
  return {
    id: "project-1",
    repositoryId: "repo-1",
    active: true,
    ticketSource: { provider: "github", repositoryId: "repo-1", board },
    settings: {},
    createdAt: "2026-11-07T08:00:00.000Z",
    updatedAt: "2026-11-07T08:00:00.000Z",
  };
}

function setup(
  options: { boards?: BoardsAnswer; project?: StoredProject | null } = {},
) {
  const project =
    options.project === undefined ? projectOf(null) : options.project;
  const getProject = vi.fn<NewProjectDependencies["service"]["getProject"]>(
    async () => project ?? undefined,
  );
  const setBoard = vi.fn<NewProjectDependencies["service"]["setBoard"]>(
    async (_id, board) => projectOf(board),
  );
  const boards = vi.fn<NewProjectDependencies["boards"]>(
    async () =>
      options.boards ?? { kind: "boards", available: true, boards: BOARDS },
  );
  const requireUser = vi.fn(async () => USER);
  const handlers = createNewProjectHandlers({
    requireUser,
    service: { createProject: vi.fn(), getProject, setBoard },
    boards,
    laneKeys: [],
    copyLanes: async () => [],
  });
  const put = (body: unknown, headers: Record<string, string> = {}): Request =>
    new Request("https://app.test/api/w/default/projects/project-1", {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { handlers, getProject, setBoard, boards, requireUser, put };
}

describe("setting the board of a project", () => {
  // #937-T01
  it("sets a board of the repository, taking the Status field from the boards GitHub lists, not from the body", async () => {
    const { handlers, setBoard, boards, put } = setup();

    const response = await handlers.setBoard(
      put({ board: { projectV2Id: "PVT_board1", statusFieldId: "x" } }),
      "project-1",
    );

    expect(response.status).toBe(400);
    expect(setBoard).not.toHaveBeenCalled();

    const ok = await handlers.setBoard(
      put({ board: { projectV2Id: "PVT_board1" } }),
      "project-1",
    );

    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(boards).toHaveBeenCalledWith("repo-1");
    expect(setBoard).toHaveBeenCalledWith("project-1", {
      projectV2Id: "PVT_board1",
      statusFieldId: "PVTSSF_1",
    });
    expect(await ok.json()).toEqual({
      project: {
        id: "project-1",
        repositoryId: "repo-1",
        active: true,
        ticketSource: {
          provider: "github",
          repositoryId: "repo-1",
          board: { projectV2Id: "PVT_board1", statusFieldId: "PVTSSF_1" },
        },
      },
    });
  });

  // #937-T02
  it("clears the board with null without asking GitHub", async () => {
    const { handlers, setBoard, boards, put } = setup({
      project: projectOf({ projectV2Id: "PVT_board1", statusFieldId: "S" }),
    });

    const response = await handlers.setBoard(put({ board: null }), "project-1");

    expect(response.status).toBe(200);
    expect(setBoard).toHaveBeenCalledWith("project-1", null);
    expect(boards).not.toHaveBeenCalled();
  });

  // #937-T03
  it("refuses a board the repository does not have and one without a Status field, naming the boards that would do", async () => {
    const { handlers, setBoard, put } = setup();

    const unknown = await handlers.setBoard(
      put({ board: { projectV2Id: "PVT_other" } }),
      "project-1",
    );
    const noStatus = await handlers.setBoard(
      put({ board: { projectV2Id: "PVT_board2" } }),
      "project-1",
    );

    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({
      error: "PROJECT_REQUEST_INVALID",
      issues: [
        expect.objectContaining({
          path: "board.projectV2Id",
          code: "unknown_board",
          available: ["PVT_board1", "PVT_board2"],
        }),
      ],
    });
    expect(noStatus.status).toBe(400);
    expect(await noStatus.json()).toMatchObject({
      issues: [
        {
          path: "board.projectV2Id",
          code: "board_without_status",
          available: ["PVT_board1"],
        },
      ],
    });
    expect(setBoard).not.toHaveBeenCalled();
  });

  // #937-T04
  it("says the boards cannot be read, and answers the failures of GitHub and of the repository with their codes", async () => {
    const body = { board: { projectV2Id: "PVT_board1" } };
    const unreadable = setup({
      boards: { kind: "boards", available: false, boards: [] },
    });
    const failed = setup({ boards: { kind: "failed" } });
    const suspended = setup({ boards: { kind: "integration_unavailable" } });
    const gone = setup({ boards: { kind: "repository_not_found" } });

    const answers = [
      await unreadable.handlers.setBoard(unreadable.put(body), "project-1"),
      await failed.handlers.setBoard(failed.put(body), "project-1"),
      await suspended.handlers.setBoard(suspended.put(body), "project-1"),
      await gone.handlers.setBoard(gone.put(body), "project-1"),
    ];

    expect(answers.map((answer) => answer.status)).toEqual([
      400, 503, 409, 404,
    ]);
    expect(await answers[0]!.json()).toMatchObject({
      issues: [{ path: "board.projectV2Id", code: "board_unavailable" }],
    });
    expect((await answers[1]!.json()) as unknown).toEqual({
      error: "PROJECT_BOARDS_UNAVAILABLE",
    });
    expect(unreadable.setBoard).not.toHaveBeenCalled();
  });

  // #937-T05
  it("answers 404 for a project the workspace does not have, and what the service refuses with its code", async () => {
    const missing = setup({ project: null });
    const raced = setup();
    raced.setBoard.mockRejectedValueOnce(
      new ProjectError("PROJECT_NOT_FOUND", "gone"),
    );

    const notFound = await missing.handlers.setBoard(
      missing.put({ board: null }),
      "nope",
    );
    const gone = await raced.handlers.setBoard(
      raced.put({ board: null }),
      "project-1",
    );

    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: "PROJECT_NOT_FOUND" });
    expect(gone.status).toBe(404);
    expect(missing.setBoard).not.toHaveBeenCalled();
  });

  // #937-T06
  it("asks for the user first, then refuses another site, a body that is no JSON object and a body that does not fit, with the issues of the check", async () => {
    const { handlers, requireUser, getProject, setBoard, put } = setup();

    const crossSite = await handlers.setBoard(
      put({ board: null }, { "sec-fetch-site": "cross-site" }),
      "project-1",
    );
    const notJson = await handlers.setBoard(put("{nope"), "project-1");
    const wrongType = await handlers.setBoard(
      new Request("https://app.test/api/w/default/projects/project-1", {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "x",
      }),
      "project-1",
    );
    const empty = await handlers.setBoard(put({}), "project-1");
    const extra = await handlers.setBoard(
      put({ board: null, name: "x" }),
      "project-1",
    );
    const badId = await handlers.setBoard(
      put({ board: { projectV2Id: "nope" } }),
      "project-1",
    );
    const tooLarge = await handlers.setBoard(
      put({ board: { projectV2Id: `PVT_${"x".repeat(5000)}` } }),
      "project-1",
    );

    expect(requireUser).toHaveBeenCalledTimes(7);
    expect(crossSite.status).toBe(403);
    expect(notJson.status).toBe(400);
    expect(wrongType.status).toBe(415);
    expect(await empty.json()).toEqual({
      error: "PROJECT_REQUEST_INVALID",
      issues: [
        expect.objectContaining({ path: "board", code: "missing_field" }),
      ],
    });
    expect(await extra.json()).toEqual({
      error: "PROJECT_REQUEST_INVALID",
      issues: [
        expect.objectContaining({
          path: "name",
          code: "unknown_field",
          available: ["board"],
        }),
      ],
    });
    expect(await badId.json()).toMatchObject({
      issues: [{ path: "board.projectV2Id", code: "invalid_value" }],
    });
    expect(tooLarge.status).toBe(413);
    expect(getProject).not.toHaveBeenCalled();
    expect(setBoard).not.toHaveBeenCalled();
  });
});
