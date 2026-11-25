// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type {
  ProjectListEntry,
  StoredProject,
} from "../../../db/repositories/projects-repository.ts";
import { createNewProjectHandlers } from "../../../projects/create-http.ts";
import { ProjectError } from "../../../projects/errors.ts";
import { lanesService } from "../lanes/services.ts";
import { contextWith, data, failure } from "../runs/test-support.ts";
import { newProjectHandlers, projectsService } from "./services.ts";

const project = (over: Partial<StoredProject> = {}): StoredProject => ({
  id: "p1",
  repositoryId: "repo-1",
  active: true,
  ticketSource: { provider: "github", board: null } as never,
  settings: { reviewSecret: "do-not-show" } as never,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  ...over,
});
const entry = (
  over: Partial<ProjectListEntry> & { repoId?: string } = {},
): ProjectListEntry => ({
  repository: {
    id: over.repoId ?? "repo-1",
    externalId: "1",
    fullName: "acme/app",
    url: "https://github.com/acme/app",
    available: true,
    integration: {
      id: "int-1",
      type: "github_app",
      displayName: "Acme",
      status: "active",
    },
  },
  project: project(),
  status: "active",
  ...over,
});

function setup(
  fakes: {
    projects?: Record<string, unknown>;
    handlers?: Record<string, unknown>;
    lanes?: Record<string, unknown>;
  },
  overrides: Parameters<typeof contextWith>[1] = {},
) {
  return contextWith(
    [
      [projectsService as never, fakes.projects ?? {}],
      [newProjectHandlers as never, fakes.handlers ?? {}],
      [lanesService as never, fakes.lanes ?? {}],
    ],
    overrides,
  );
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("list_projects and get_project", () => {
  // #1145-T30
  it("lists projects with their repository and the repositories that have none, without review settings", async () => {
    const answer = await data(
      "list_projects",
      setup({
        projects: {
          listProjects: async () => [
            entry(),
            entry({ project: null, status: "inactive", repoId: "repo-2" }),
          ],
        },
      }),
      {},
    );
    expect(answer).toMatchObject({
      projects: [
        {
          id: "p1",
          repositoryId: "repo-1",
          status: "active",
          repository: { fullName: "acme/app" },
        },
      ],
      repositoriesWithoutProject: [{ id: "repo-2" }],
    });
    expect(JSON.stringify(answer)).not.toContain("do-not-show");
  });

  // #1145-T31
  it("gets one project with its lanes, and an unknown id is not_found", async () => {
    const context = setup({
      projects: { listProjects: async () => [entry()] },
      lanes: {
        list: async () => ({
          maximum: 20,
          workflows: [{ id: "lane-1", name: "Issue to PR" }],
        }),
      },
    });
    expect(
      await data("get_project", context, { projectId: "p1" }),
    ).toMatchObject({
      project: { id: "p1", repository: { fullName: "acme/app" } },
      lanes: [
        {
          id: "lane-1",
          url: "https://factory.example.test/w/acme/workflows/lane-1",
        },
      ],
    });
    expect(
      await failure("get_project", context, { projectId: "nope" }),
    ).toMatchObject({ error: "not_found" });
  });
});

describe("create_project", () => {
  // #1145-T32
  it("sends the body to the route's own handler and answers its result", async () => {
    const create = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(await request.json()).toEqual({
        repositoryId: "repo-1",
        lanes: ["issue-to-pr"],
      });
      return json(
        {
          project: { id: "p9" },
          lanes: [{ key: "issue-to-pr", ok: true, workflowId: "l1" }],
        },
        201,
      );
    });
    const answer = await data(
      "create_project",
      setup({ handlers: { create } }),
      {
        repositoryId: "repo-1",
        lanes: ["issue-to-pr"],
      },
    );
    expect(answer).toMatchObject({ project: { id: "p9" } });
  });

  // #1145-T33
  it("maps the route's refusals: every issue of a bad body, an existing project, GitHub down", async () => {
    const issues = [
      {
        path: "board.projectV2Id",
        code: "unknown_board",
        message: "m",
        available: ["PVT_a"],
      },
    ];
    const refuse = (error: string, status: number, extra = {}) =>
      setup({
        handlers: { create: async () => json({ error, ...extra }, status) },
      });
    expect(
      await failure(
        "create_project",
        refuse("PROJECT_REQUEST_INVALID", 400, { issues }),
        { repositoryId: "r" },
      ),
    ).toMatchObject({
      error: "invalid_input",
      code: "PROJECT_REQUEST_INVALID",
      issues,
    });
    expect(
      await failure("create_project", refuse("PROJECT_ALREADY_EXISTS", 409), {
        repositoryId: "r",
      }),
    ).toMatchObject({ error: "conflict" });
    expect(
      await failure(
        "create_project",
        refuse("PROJECT_BOARDS_UNAVAILABLE", 503),
        { repositoryId: "r" },
      ),
    ).toMatchObject({ error: "unavailable" });
    expect(
      await failure(
        "create_project",
        refuse("PROJECT_REPOSITORY_NOT_FOUND", 404),
        { repositoryId: "r" },
      ),
    ).toMatchObject({ error: "not_found" });
  });

  // #1145-T34
  it("runs through the real handlers: an unknown board is invalid_input with the boards there are, and no board is asked for a body that names none", async () => {
    const createProject = vi.fn(async () => project());
    const handlers = createNewProjectHandlers({
      requireUser: async () => ({}) as never,
      service: {
        createProject,
        findProject: async () => entry(),
        getProject: async () => project(),
        setBoard: async () => project(),
      },
      boards: async () => ({
        kind: "boards",
        available: true,
        boards: [
          {
            projectV2Id: "PVT_a",
            number: 1,
            title: "Board",
            statusFieldId: "f",
            statuses: [],
          },
        ],
      }),
      laneKeys: ["issue-to-pr"],
      copyLanes: async () => [],
    });
    const context = setup({ handlers });
    const fail = await failure("create_project", context, {
      repositoryId: "repo-1",
      board: { projectV2Id: "PVT_zzz" },
    });
    expect(fail).toMatchObject({
      error: "invalid_input",
      issues: [{ code: "unknown_board", available: ["PVT_a"] }],
    });
    expect(createProject).not.toHaveBeenCalled();
    await data("create_project", context, { repositoryId: "repo-1" });
    expect(createProject).toHaveBeenCalledWith("repo-1", null);
  });

  // #1145-T35
  it("is for Owners and Admins with the control scope, and takes no unknown field", async () => {
    const create = vi.fn(async () => json({ project: {}, lanes: [] }, 201));
    const handlers = { create };
    expect(
      await failure("create_project", setup({ handlers }, { role: "member" }), {
        repositoryId: "r",
      }),
    ).toMatchObject({ error: "forbidden" });
    expect(
      await failure(
        "create_project",
        setup({ handlers }, { scopes: ["factory:read"] }),
        { repositoryId: "r" },
      ),
    ).toMatchObject({ error: "insufficient_scope" });
    expect(
      await failure("create_project", setup({ handlers }), {
        repositoryId: "r",
        settings: {},
      }),
    ).toMatchObject({ error: "invalid_input" });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("update_project", () => {
  // #1145-T36
  it("sets or clears the board through the route's handler for the project", async () => {
    const setBoard = vi.fn(async (request: Request, projectId: string) => {
      expect(projectId).toBe("p1");
      return json({ project: { id: "p1", body: await request.json() } });
    });
    const context = setup({ handlers: { setBoard } });
    expect(
      await data("update_project", context, {
        projectId: "p1",
        board: { projectV2Id: "PVT_a" },
      }),
    ).toMatchObject({ project: { body: { board: { projectV2Id: "PVT_a" } } } });
    expect(
      await data("update_project", context, { projectId: "p1", board: null }),
    ).toMatchObject({ project: { body: { board: null } } });
    expect(
      await failure("update_project", context, { projectId: "p1" }),
    ).toMatchObject({ error: "invalid_input" });
  });

  // #1145-T37
  it("maps an unknown project and a Jira project (no board)", async () => {
    const answer = (error: string, status: number) =>
      setup({ handlers: { setBoard: async () => json({ error }, status) } });
    expect(
      await failure("update_project", answer("PROJECT_NOT_FOUND", 404), {
        projectId: "x",
        board: null,
      }),
    ).toMatchObject({ error: "not_found" });
    expect(
      await failure(
        "update_project",
        answer("PROJECT_BOARD_NOT_SUPPORTED", 409),
        { projectId: "x", board: null },
      ),
    ).toMatchObject({ error: "conflict" });
  });
});

describe("archive_project", () => {
  // #1145-T38
  it("switches the project of its repository off and says whether anything changed", async () => {
    const deactivateProject = vi.fn(async () => ({
      project: project({ active: false }),
      changed: true,
    }));
    const answer = await data(
      "archive_project",
      setup({
        projects: { getProject: async () => project(), deactivateProject },
      }),
      { projectId: "p1" },
    );
    expect(deactivateProject).toHaveBeenCalledWith("repo-1");
    expect(answer).toMatchObject({
      project: { id: "p1", active: false },
      changed: true,
    });
  });

  // #1145-T39
  it("answers an unknown project as not_found, a member as forbidden, and a service refusal by its code", async () => {
    const deactivateProject = vi.fn();
    expect(
      await failure(
        "archive_project",
        setup({
          projects: { getProject: async () => undefined, deactivateProject },
        }),
        { projectId: "x" },
      ),
    ).toMatchObject({ error: "not_found" });
    expect(
      await failure(
        "archive_project",
        setup(
          {
            projects: { getProject: async () => project(), deactivateProject },
          },
          { role: "member" },
        ),
        { projectId: "p1" },
      ),
    ).toMatchObject({ error: "forbidden" });
    expect(
      await failure(
        "archive_project",
        setup({
          projects: {
            getProject: async () => project(),
            deactivateProject: async () => {
              throw new ProjectError("PROJECT_REPOSITORY_NOT_FOUND", "gone");
            },
          },
        }),
        { projectId: "p1" },
      ),
    ).toMatchObject({
      error: "not_found",
      code: "PROJECT_REPOSITORY_NOT_FOUND",
    });
    expect(deactivateProject).not.toHaveBeenCalled();
  });
});
