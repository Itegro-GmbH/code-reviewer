// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers of the factory's new project (#922): the user first, then where the request comes from and what it carries, the strict check
// of the body, the board against the boards GitHub has, then the service and the lanes. The collaborators are fakes.
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import type {
  ProjectListEntry,
  StoredProject,
} from "../db/repositories/projects-repository.ts";
import type { BoardInfo } from "../integrations/provider.ts";
import {
  createNewProjectHandlers,
  type BoardsAnswer,
  type JiraProjectAnswer,
  type JiraProjectsAnswer,
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

/** The repository "repo-1" as the list of projects has it. */
function entryOf(
  over: {
    available?: boolean;
    integrationStatus?: "active" | "disabled";
    project?: StoredProject | null;
  } = {},
): ProjectListEntry {
  const available = over.available ?? true;
  return {
    repository: {
      id: "repo-1",
      externalId: "1",
      fullName: "acme/shop",
      url: "https://github.test/acme/shop",
      available,
      integration: {
        id: "int-1",
        type: "github_app",
        displayName: "acme",
        status: over.integrationStatus ?? "active",
      },
    },
    project: over.project ?? null,
    status: available ? "inactive" : "unavailable",
  };
}

function setup(
  options: {
    boards?: BoardsAnswer;
    createProject?: NewProjectDependencies["service"]["createProject"];
    lanes?: LaneCopy[];
    /** What the Jira site answers to the list of its projects; left out: the handlers are wired without Jira. */
    jira?: JiraProjectsAnswer;
    /** What the Jira site answers to the question for the one project of a creation. */
    jiraProject?: JiraProjectAnswer;
    /** The repository as the list of projects has it; left out: a repository that can be switched on, without a project. */
    entry?: ProjectListEntry | undefined | null;
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
  const jiraProjects = vi.fn<
    NonNullable<NewProjectDependencies["jiraProjects"]>
  >(async () => options.jira ?? { kind: "unavailable" });
  const jiraProject = vi.fn<NonNullable<NewProjectDependencies["jiraProject"]>>(
    async () =>
      options.jiraProject ?? { kind: "project", project: { key: "PROJ" } },
  );
  const findProject = vi.fn<NewProjectDependencies["service"]["findProject"]>(
    async () =>
      options.entry === null ? undefined : (options.entry ?? entryOf()),
  );
  const handlers = createNewProjectHandlers({
    requireUser,
    service: {
      createProject,
      findProject,
      getProject: async () => undefined,
      setBoard: async () => {
        throw new Error("not under test");
      },
    },
    boards,
    laneKeys: ["issue-to-pr", "review-a-pull-request"],
    copyLanes,
    ...(options.jira === undefined ? {} : { jiraProjects }),
    ...(options.jiraProject === undefined && options.jira === undefined
      ? {}
      : { jiraProject }),
  });
  const post = (body: unknown, headers: Record<string, string> = {}): Request =>
    new Request("https://app.test/api/w/default/projects", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return {
    handlers,
    createProject,
    boards,
    copyLanes,
    requireUser,
    post,
    jiraProjects,
    jiraProject,
    findProject,
  };
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

describe("creating a project on a Jira project (#1038)", () => {
  const jiraBody = (over: Record<string, unknown> = {}) => ({
    repositoryId: "repo-1",
    ticketSource: {
      provider: "jira",
      connectionId: "conn-1",
      projectKey: "PROJ",
    },
    ...over,
  });

  // #1038-T01
  it("creates the project with the Jira source after the site has the project, and asks GitHub for no board", async () => {
    const { handlers, createProject, boards, jiraProject, jiraProjects, post } =
      setup({
        jira: { kind: "unavailable" },
        createProject: async (repositoryId, _board, jira) => ({
          ...projectOf(null),
          repositoryId,
          ticketSource: {
            provider: "jira",
            repositoryId,
            board: null,
            ...(jira ?? { connectionId: "?", projectKey: "?" }),
          },
        }),
      });

    const response = await handlers.create(post(jiraBody()));

    expect(response.status).toBe(201);
    expect(((await response.json()) as { project: unknown }).project).toEqual({
      id: "project-1",
      repositoryId: "repo-1",
      active: true,
      ticketSource: {
        provider: "jira",
        repositoryId: "repo-1",
        board: null,
        connectionId: "conn-1",
        projectKey: "PROJ",
      },
    });
    // One question for the one project, never the list of the site's projects (a site can have thousands of them).
    expect(jiraProject).toHaveBeenCalledExactlyOnceWith("conn-1", "PROJ");
    expect(jiraProjects).not.toHaveBeenCalled();
    expect(createProject).toHaveBeenCalledWith("repo-1", null, {
      connectionId: "conn-1",
      projectKey: "PROJ",
    });
    expect(boards).not.toHaveBeenCalled();
  });

  // #1038-T01 (finding of the review of #1044)
  it("refuses a project the site does not have without naming any key of the site, and writes nothing", async () => {
    const { handlers, createProject, post } = setup({
      jiraProject: { kind: "project_not_found" },
    });

    const response = await handlers.create(
      post(
        jiraBody({
          ticketSource: {
            provider: "jira",
            connectionId: "conn-1",
            projectKey: "NOPE",
          },
        }),
      ),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      issues: Record<string, unknown>[];
    };
    expect(body).toEqual({
      error: "PROJECT_REQUEST_INVALID",
      issues: [
        expect.objectContaining({
          path: "ticketSource.projectKey",
          code: "unknown_jira_project",
        }),
      ],
    });
    // The keys of a site are its business: whoever may create a project may not read the list of the projects the account sees here.
    expect(body.issues[0]).not.toHaveProperty("available");
    expect(createProject).not.toHaveBeenCalled();
  });

  // #1038-T01 (finding of the review of #1044)
  it("looks at the repository before it asks Jira: an unknown, an unavailable one and one with a project already ask nothing", async () => {
    const cases = [
      { entry: null, error: "PROJECT_REPOSITORY_NOT_FOUND", status: 404 },
      {
        entry: entryOf({ available: false }),
        error: "PROJECT_REPOSITORY_UNAVAILABLE",
        status: 409,
      },
      {
        entry: entryOf({ available: false, integrationStatus: "disabled" }),
        error: "PROJECT_INTEGRATION_UNAVAILABLE",
        status: 409,
      },
      {
        entry: entryOf({ project: projectOf(null) }),
        error: "PROJECT_ALREADY_EXISTS",
        status: 409,
      },
    ] as const;
    for (const { entry, error, status } of cases) {
      const { handlers, jiraProject, createProject, post } = setup({
        jiraProject: { kind: "project", project: { key: "PROJ" } },
        entry,
      });

      const response = await handlers.create(post(jiraBody()));

      expect(response.status, error).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(jiraProject, error).not.toHaveBeenCalled();
      expect(createProject, error).not.toHaveBeenCalled();
    }
  });

  // #1038-T01
  it("refuses a connection the workspace does not have, a broken one, and a site that cannot be asked, each with its own answer", async () => {
    const unknown = setup({ jiraProject: { kind: "connection_not_found" } });
    const refused = await unknown.handlers.create(unknown.post(jiraBody()));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: "PROJECT_REQUEST_INVALID",
      issues: [
        { path: "ticketSource.connectionId", code: "unknown_connection" },
      ],
    });

    const broken = setup({ jiraProject: { kind: "connection_broken" } });
    const brokenAnswer = await broken.handlers.create(broken.post(jiraBody()));
    expect(brokenAnswer.status).toBe(409);
    expect(await brokenAnswer.json()).toEqual({
      error: "PROJECT_JIRA_CONNECTION_BROKEN",
    });

    const down = setup({ jiraProject: { kind: "unavailable" } });
    const downAnswer = await down.handlers.create(down.post(jiraBody()));
    expect(downAnswer.status).toBe(503);
    expect(await downAnswer.json()).toEqual({
      error: "PROJECT_JIRA_UNAVAILABLE",
    });

    // Wired without Jira (a deployment that has none): a Jira project cannot be named.
    const none = setup();
    const noneAnswer = await none.handlers.create(none.post(jiraBody()));
    expect(noneAnswer.status).toBe(503);
    expect(none.createProject).not.toHaveBeenCalled();
    for (const each of [unknown, broken, down])
      expect(each.createProject).not.toHaveBeenCalled();
  });

  // #1038-T01
  it("answers a connection that was removed between the check and the write with the code of the service", async () => {
    const { handlers, post } = setup({
      jiraProject: { kind: "project", project: { key: "PROJ" } },
      createProject: async () => {
        throw new ProjectError(
          "PROJECT_JIRA_CONNECTION_NOT_FOUND",
          "The workspace has no Jira connection with this id.",
        );
      },
    });

    const response = await handlers.create(post(jiraBody()));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "PROJECT_JIRA_CONNECTION_NOT_FOUND",
    });
  });

  // #1038
  it("refuses a GitHub board next to a Jira project before anybody is asked", async () => {
    const { handlers, jiraProject, boards, findProject, post } = setup({
      jiraProject: { kind: "project", project: { key: "PROJ" } },
    });

    const response = await handlers.create(
      post(jiraBody({ board: { projectV2Id: "PVT_board1" } })),
    );

    expect(response.status).toBe(400);
    expect(jiraProject).not.toHaveBeenCalled();
    expect(findProject).not.toHaveBeenCalled();
    expect(boards).not.toHaveBeenCalled();
  });

  // #1038 (finding of the review of #1044)
  it("refuses the lanes that read and write GitHub issues for a Jira project before anybody is asked", async () => {
    const { handlers, jiraProject, createProject, copyLanes, post } = setup({
      jiraProject: { kind: "project", project: { key: "PROJ" } },
    });

    const response = await handlers.create(
      post(jiraBody({ lanes: ["issue-to-pr"] })),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "PROJECT_REQUEST_INVALID",
      issues: [{ path: "lanes/0", code: "lane_not_for_jira" }],
    });
    expect(jiraProject).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
    expect(copyLanes).not.toHaveBeenCalled();
  });
});

describe("the projects of a Jira connection (#1038)", () => {
  const get = () =>
    new Request(
      "https://app.test/api/w/default/jira/connections/conn-1/projects",
    );

  // #1038-T01
  it("lists the key and the name of the projects of the site, for the dialog", async () => {
    const { handlers, jiraProjects, requireUser } = setup({
      jira: {
        kind: "projects",
        complete: false,
        projects: [{ key: "PROJ", name: "Project" }],
      },
    });

    const response = await handlers.jiraProjects(get(), "conn-1");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      complete: false,
      projects: [{ key: "PROJ", name: "Project" }],
    });
    expect(requireUser).toHaveBeenCalled();
    expect(jiraProjects).toHaveBeenCalledWith("conn-1");
  });

  // #1038
  it("answers an unknown connection with 404, a broken one with 409, and a site that cannot be asked with 503", async () => {
    for (const [kind, status, error] of [
      ["connection_not_found", 404, "PROJECT_JIRA_CONNECTION_NOT_FOUND"],
      ["connection_broken", 409, "PROJECT_JIRA_CONNECTION_BROKEN"],
      ["unavailable", 503, "PROJECT_JIRA_UNAVAILABLE"],
    ] as const) {
      const { handlers } = setup({ jira: { kind } });
      const response = await handlers.jiraProjects(get(), "conn-1");
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
  });
});
