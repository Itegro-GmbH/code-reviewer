// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers of the factory's new project (#922): the user first, then where the request comes from and what it carries, the strict check
// of the body, the board against the boards GitHub has, then the service and the lanes. The collaborators are fakes.
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import type { BoardInfo } from "../integrations/provider.ts";
import {
  createNewProjectHandlers,
  type BoardsAnswer,
  type LaneCopy,
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
  options: {
    boards?: BoardsAnswer;
    createProject?: NewProjectDependencies["service"]["createProject"];
    lanes?: LaneCopy[];
  } = {},
) {
  const createProject = vi.fn<
    NewProjectDependencies["service"]["createProject"]
  >(
    options.createProject ??
      (async (_repository, board) => projectOf(board ?? null)),
  );
  const boards = vi.fn<NewProjectDependencies["boards"]>(
    async () =>
      options.boards ?? { kind: "boards", available: true, boards: BOARDS },
  );
  const copyLanes = vi.fn<NewProjectDependencies["copyLanes"]>(
    async () => options.lanes ?? [],
  );
  const requireUser = vi.fn(async () => USER);
  const handlers = createNewProjectHandlers({
    requireUser,
    service: {
      createProject,
      getProject: async () => undefined,
      setBoard: async () => {
        throw new Error("not under test");
      },
    },
    boards,
    laneKeys: ["issue-to-pr", "review-a-pull-request"],
    copyLanes,
  });
  const post = (body: unknown, headers: Record<string, string> = {}): Request =>
    new Request("https://app.test/api/w/default/projects", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { handlers, createProject, boards, copyLanes, requireUser, post };
}

describe("creating a project", () => {
  // #922-T70
  it("creates a project without a board and answers 201 with its ticket source", async () => {
    const { handlers, createProject, boards, copyLanes, post } = setup();

    const response = await handlers.create(post({ repositoryId: "repo-1" }));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      project: {
        id: "project-1",
        repositoryId: "repo-1",
        active: true,
        ticketSource: {
          provider: "github",
          repositoryId: "repo-1",
          board: null,
        },
      },
      lanes: [],
    });
    expect(createProject).toHaveBeenCalledWith("repo-1", null);
    // No board named: GitHub is not asked, and no lane is copied.
    expect(boards).not.toHaveBeenCalled();
    expect(copyLanes).not.toHaveBeenCalled();
  });

  // #922-T71
  it("creates a project with a board, taking the Status field from the boards GitHub lists, not from the body", async () => {
    const { handlers, createProject, boards, post } = setup();

    const response = await handlers.create(
      post({
        repositoryId: "repo-1",
        board: { projectV2Id: "PVT_board1" },
      }),
    );

    expect(response.status).toBe(201);
    expect(boards).toHaveBeenCalledWith("repo-1");
    expect(createProject).toHaveBeenCalledWith("repo-1", {
      projectV2Id: "PVT_board1",
      statusFieldId: "PVTSSF_1",
    });
    const body = (await response.json()) as {
      project: { ticketSource: { board: unknown } };
    };
    expect(body.project.ticketSource.board).toEqual({
      projectV2Id: "PVT_board1",
      statusFieldId: "PVTSSF_1",
    });
  });

  // #922-T72
  it("copies the lanes that are asked for as the user who asks, and reports each", async () => {
    const { handlers, copyLanes, post } = setup({
      lanes: [
        {
          key: "issue-to-pr",
          ok: true,
          workflow: { id: "wf-1", name: "Issue to PR" },
        },
        { key: "review-a-pull-request", ok: false, code: "WORKFLOW_INVALID" },
      ],
    });

    const response = await handlers.create(
      post({
        repositoryId: "repo-1",
        lanes: ["issue-to-pr", "review-a-pull-request"],
      }),
    );

    expect(response.status).toBe(201);
    expect(copyLanes).toHaveBeenCalledWith(USER, "project-1", [
      "issue-to-pr",
      "review-a-pull-request",
    ]);
    expect(((await response.json()) as { lanes: unknown }).lanes).toEqual([
      { key: "issue-to-pr", ok: true, workflowId: "wf-1" },
      { key: "review-a-pull-request", ok: false, code: "WORKFLOW_INVALID" },
    ]);
  });

  // #922-T80
  it("answers 201 with every lane failed when copying the lanes throws, and keeps the project", async () => {
    const { handlers, createProject, copyLanes, post } = setup();
    copyLanes.mockRejectedValueOnce(new Error("the database went away"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handlers.create(
      post({
        repositoryId: "repo-1",
        lanes: ["issue-to-pr", "review-a-pull-request"],
      }),
    );

    expect(response.status).toBe(201);
    expect(createProject).toHaveBeenCalledTimes(1);
    const body = (await response.json()) as {
      project: { id: string };
      lanes: unknown;
    };
    expect(body.project.id).toBe("project-1");
    expect(body.lanes).toEqual([
      { key: "issue-to-pr", ok: false, code: "LANE_COPY_FAILED" },
      { key: "review-a-pull-request", ok: false, code: "LANE_COPY_FAILED" },
    ]);
    // The text of the error is never logged.
    expect(JSON.stringify(logged.mock.calls)).not.toContain("database");
    logged.mockRestore();
  });

  // #922-T73
  it("refuses a board the repository does not have, naming the boards it has, and writes nothing", async () => {
    const { handlers, createProject, post } = setup();

    const response = await handlers.create(
      post({ repositoryId: "repo-1", board: { projectV2Id: "PVT_other" } }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "PROJECT_REQUEST_INVALID",
      issues: [
        expect.objectContaining({
          path: "board.projectV2Id",
          code: "unknown_board",
          available: ["PVT_board1", "PVT_board2"],
        }),
      ],
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  // #922-T74
  it("refuses a board without a Status field, naming the boards that have one", async () => {
    const { handlers, createProject, post } = setup();

    const response = await handlers.create(
      post({ repositoryId: "repo-1", board: { projectV2Id: "PVT_board2" } }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      issues: [
        {
          path: "board.projectV2Id",
          code: "board_without_status",
          available: ["PVT_board1"],
        },
      ],
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  // #922-T75
  it("says the boards cannot be read when the App may not read them, and answers the failures of GitHub and of the repository with their codes", async () => {
    const named = {
      repositoryId: "repo-1",
      board: { projectV2Id: "PVT_board1" },
    };

    const unreadable = setup({
      boards: { kind: "boards", available: false, boards: [] },
    });
    const response = await unreadable.handlers.create(unreadable.post(named));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      issues: [{ code: "board_unavailable", available: [] }],
    });

    for (const [answer, status, code] of [
      [{ kind: "failed" }, 503, "PROJECT_BOARDS_UNAVAILABLE"],
      [{ kind: "repository_not_found" }, 404, "PROJECT_REPOSITORY_NOT_FOUND"],
      [
        { kind: "integration_unavailable" },
        409,
        "PROJECT_INTEGRATION_UNAVAILABLE",
      ],
    ] as const) {
      const { handlers, post } = setup({ boards: answer });
      const refused = await handlers.create(post(named));
      expect(refused.status).toBe(status);
      expect(await refused.json()).toEqual({ error: code });
    }
  });

  // #922-T76
  it("answers what the service refuses with its code", async () => {
    const { handlers, post } = setup({
      createProject: async () => {
        throw new ProjectError("PROJECT_ALREADY_EXISTS", "taken");
      },
    });

    const response = await handlers.create(post({ repositoryId: "repo-1" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "PROJECT_ALREADY_EXISTS" });
  });

  // #922-T77
  it("asks for the user first, then refuses another site, a body that is no JSON object and a body that does not fit, with the issues of the check", async () => {
    const { handlers, requireUser, createProject, post } = setup();

    const crossSite = await handlers.create(
      post({ repositoryId: "repo-1" }, { "sec-fetch-site": "cross-site" }),
    );
    const notJson = await handlers.create(post("{nope"));
    const wrongType = await handlers.create(
      new Request("https://app.test/api/w/default/projects", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x",
      }),
    );
    const invalid = await handlers.create(
      post({ repositoryId: "repo-1", lanes: ["nothing"], color: 1 }),
    );
    const tooLarge = await handlers.create(
      post({ repositoryId: "x".repeat(5000) }),
    );

    expect(requireUser).toHaveBeenCalledTimes(5);
    expect(crossSite.status).toBe(403);
    expect(notJson.status).toBe(400);
    expect(wrongType.status).toBe(415);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "PROJECT_REQUEST_INVALID",
      issues: [
        expect.objectContaining({ path: "color", code: "unknown_field" }),
        expect.objectContaining({
          path: "lanes/0",
          code: "unknown_lane",
          available: ["issue-to-pr", "review-a-pull-request"],
        }),
      ],
    });
    expect(tooLarge.status).toBe(413);
    expect(createProject).not.toHaveBeenCalled();
  });
});

describe("the boards of a repository", () => {
  // #922-T78
  it("lists them with the options of their Status field, without the ids of the fields", async () => {
    const { handlers, requireUser } = setup();

    const response = await handlers.boards(
      new Request("https://app.test/api/w/default/repositories/repo-1/boards"),
      "repo-1",
    );

    expect(requireUser).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: true,
      boards: [
        {
          projectV2Id: "PVT_board1",
          number: 1,
          title: "Roadmap",
          hasStatusField: true,
          statuses: ["Todo", "Done"],
        },
        {
          projectV2Id: "PVT_board2",
          number: 2,
          title: "Loose",
          hasStatusField: false,
          statuses: [],
        },
      ],
    });
  });

  // #922-T79
  it("says available false when the App may not read them, and answers an unknown repository with 404", async () => {
    const unreadable = setup({
      boards: { kind: "boards", available: false, boards: [] },
    });
    const missing = setup({ boards: { kind: "repository_not_found" } });
    const request = new Request("https://app.test/boards");

    expect(
      await (await unreadable.handlers.boards(request, "repo-1")).json(),
    ).toEqual({ available: false, boards: [] });
    const refused = await missing.handlers.boards(request, "nope");
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({
      error: "PROJECT_REPOSITORY_NOT_FOUND",
    });
  });
});
