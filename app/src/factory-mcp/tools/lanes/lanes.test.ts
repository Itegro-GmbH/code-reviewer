// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type {
  StoredWorkflow,
  StoredWorkflowVersion,
  WorkflowsRepository,
} from "../../../db/repositories/workflows-repository.ts";
import type { NamedRunner } from "../../../named-runners/types.ts";
import { WorkflowError } from "../../../workflows/errors.ts";
import { createWorkflowService } from "../../../workflows/service.ts";
import { projectsService } from "../projects/services.ts";
import { contextWith, data, failure } from "../runs/test-support.ts";
import { applyEdits } from "./edits.ts";
import { lanesService } from "./services.ts";

const LANE = "lane-1";
const summary = (over: Record<string, unknown> = {}) => ({
  id: LANE,
  projectId: "p1",
  name: "Issue to PR",
  version: 3,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
  archivedAt: null,
  ...over,
});
const view = (over: Record<string, unknown> = {}) => ({
  ...summary(),
  documentVersion: 3,
  document: { version: 1, name: "Issue to PR", steps: [{ id: "a" }] },
  versions: [
    {
      version: 3,
      savedAt: "2026-11-20T00:00:00.000Z",
      savedBy: "u1",
      changeDescription: "Use a bigger runner",
    },
  ],
  ...over,
});

function setup(
  service: Record<string, unknown>,
  overrides: Parameters<typeof contextWith>[1] = {},
  projects: Record<string, unknown> = {},
) {
  return contextWith(
    [
      [lanesService as never, service],
      [projectsService as never, projects],
    ],
    overrides,
  );
}

const refuse = (
  code: ConstructorParameters<typeof WorkflowError>[0],
  details: ConstructorParameters<typeof WorkflowError>[2] = {},
) => new WorkflowError(code, `service says ${code}`, details);

describe("list_lanes", () => {
  // #1145-T1
  it("lists the lanes of the named project with the address of each page", async () => {
    const list = vi.fn(async () => ({ workflows: [summary()], maximum: 20 }));
    const answer = await data("list_lanes", setup({ list }), {
      projectId: "p1",
    });
    expect(list).toHaveBeenCalledWith("p1");
    expect(answer).toEqual({
      lanes: [
        {
          ...summary(),
          url: "https://factory.example.test/w/acme/workflows/lane-1",
        },
      ],
      maximumPerProject: 20,
    });
  });

  // #1145-T2
  it("without a project lists the lanes of every active project", async () => {
    const list = vi.fn(async (projectId: string) => ({
      workflows: [summary({ id: `lane-${projectId}`, projectId })],
      maximum: 20,
    }));
    const answer = await data(
      "list_lanes",
      setup(
        { list },
        {},
        {
          listProjects: async () => [
            { project: { id: "p1", active: true } },
            { project: { id: "p2", active: false } },
            { project: null },
            { project: { id: "p3", active: true } },
          ],
        },
      ),
      {},
    );
    expect(list.mock.calls.map((call) => call[0])).toEqual(["p1", "p3"]);
    expect((answer.lanes as { id: string }[]).map((l) => l.id)).toEqual([
      "lane-p1",
      "lane-p3",
    ]);
  });

  // #1145-T3
  it("maps an unknown project to not_found and a member may list", async () => {
    const fail = await failure(
      "list_lanes",
      setup(
        {
          list: async () => {
            throw refuse("WORKFLOW_PROJECT_NOT_FOUND");
          },
        },
        { role: "member", scopes: ["factory:read"] },
      ),
      { projectId: "nope" },
    );
    expect(fail).toMatchObject({
      error: "not_found",
      code: "WORKFLOW_PROJECT_NOT_FOUND",
    });
  });
});

describe("get_lane and the versions", () => {
  // #1145-T4
  it("answers the lane with its document, versions and address; an older version on request", async () => {
    const get = vi.fn(async () => view());
    const context = setup({ get });
    const answer = await data("get_lane", context, { laneId: LANE });
    expect(get).toHaveBeenCalledWith(LANE, undefined);
    expect(answer).toMatchObject({
      lane: { id: LANE, version: 3, document: { steps: [{ id: "a" }] } },
      url: "https://factory.example.test/w/acme/workflows/lane-1",
    });
    await data("get_lane_version", context, { laneId: LANE, version: 2 });
    expect(get).toHaveBeenLastCalledWith(LANE, 2);
  });

  // #1145-T5
  it("lists the versions without their documents", async () => {
    const answer = await data(
      "list_lane_versions",
      setup({ get: async () => view() }),
      { laneId: LANE },
    );
    expect(answer).toEqual({
      laneId: LANE,
      name: "Issue to PR",
      currentVersion: 3,
      archivedAt: null,
      versions: view().versions,
    });
  });

  // #1145-T6
  it("answers a lane or version that is not there as not_found", async () => {
    const context = setup({
      get: async () => {
        throw refuse("WORKFLOW_VERSION_NOT_FOUND");
      },
    });
    expect(
      await failure("get_lane_version", context, { laneId: LANE, version: 9 }),
    ).toMatchObject({ error: "not_found" });
    expect(await failure("get_lane", context, {})).toMatchObject({
      error: "invalid_input",
    });
  });
});

describe("validate_lane", () => {
  // #1145-T7
  it("answers a document with problems as a normal answer with every error", async () => {
    const errors = [
      {
        path: "/steps/0/runner",
        code: "runner_unknown" as const,
        message: "x",
        available: ["r1"],
      },
    ];
    const validate = vi.fn(async () => ({
      valid: false,
      errors,
      truncated: false,
      steps: 1,
    }));
    const answer = await data(
      "validate_lane",
      setup({ validate }, { scopes: ["factory:read"], role: "member" }),
      {
        document: { name: "x" },
      },
    );
    expect(validate).toHaveBeenCalledWith({ name: "x" });
    expect(answer).toMatchObject({ valid: false, errors, steps: 1 });
  });
});

describe("create_lane", () => {
  // #1145-T8
  it("saves the document in the project as the signed-in person and answers the lane", async () => {
    const create = vi.fn(async () => view({ version: 1, documentVersion: 1 }));
    const answer = await data("create_lane", setup({ create }), {
      projectId: "p1",
      document: { name: "New", description: "d" },
    });
    expect(create).toHaveBeenCalledWith({ id: "user-ada" }, "p1", {
      name: "New",
      description: "d",
    });
    expect(answer).toMatchObject({ lane: { id: LANE } });
  });

  // #1145-T9
  it("answers a document that does not pass as invalid_input with every problem", async () => {
    const errors = [
      {
        path: "/steps/0/runner",
        code: "runner_unknown" as const,
        message: "m",
        available: ["r1", "r2"],
      },
      {
        path: "/steps/1/model",
        code: "model_not_allowed" as const,
        message: "n",
      },
    ];
    const fail = await failure(
      "create_lane",
      setup({
        create: async () => {
          throw refuse("WORKFLOW_INVALID", { errors, truncated: true });
        },
      }),
      { projectId: "p1", document: {} },
    );
    expect(fail).toMatchObject({
      error: "invalid_input",
      code: "WORKFLOW_INVALID",
      errors,
      truncated: true,
    });
  });

  // #1145-T10
  it.each([
    ["WORKFLOW_NAME_TAKEN", "conflict"],
    ["WORKFLOW_LIMIT_REACHED", "limit_reached"],
    ["WORKFLOW_PROJECT_INACTIVE", "conflict"],
    ["WORKFLOW_PROJECT_NOT_FOUND", "not_found"],
  ] as const)("maps %s to %s", async (serviceCode, code) => {
    const fail = await failure(
      "create_lane",
      setup({
        create: async () => {
          throw refuse(serviceCode, { maximum: 20 });
        },
      }),
      { projectId: "p1", document: {} },
    );
    expect(fail).toMatchObject({ error: code, code: serviceCode });
  });

  // #1145-T11
  it("is refused to a member and to a token with the read scope, before the service is asked", async () => {
    const create = vi.fn();
    expect(
      await failure("create_lane", setup({ create }, { role: "member" }), {
        projectId: "p1",
        document: {},
      }),
    ).toMatchObject({ error: "forbidden" });
    expect(
      await failure(
        "create_lane",
        setup({ create }, { scopes: ["factory:read"] }),
        {
          projectId: "p1",
          document: {},
        },
      ),
    ).toMatchObject({ error: "insufficient_scope" });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("update_lane", () => {
  // #1145-T12
  it("saves the whole document with the change note and the expected version", async () => {
    const update = vi.fn(async () => view({ version: 4 }));
    const answer = await data("update_lane", setup({ update }), {
      laneId: LANE,
      document: { name: "Issue to PR", steps: [] },
      changeDescription: "Fewer steps",
      expectedVersion: 3,
    });
    expect(update).toHaveBeenCalledWith(
      { id: "user-ada" },
      LANE,
      { name: "Issue to PR", steps: [], changeDescription: "Fewer steps" },
      3,
    );
    expect(answer).toMatchObject({ lane: { version: 4 } });
  });

  // #1145-T13
  it("applies edits to the version it was told it read: switch a step to another runner and to the harness claude-code", async () => {
    const get = vi.fn(async () =>
      view({
        document: {
          name: "Issue to PR",
          steps: [{ id: "a", runner: "old", harness: "opencode" }],
        },
      }),
    );
    const update = vi.fn(async () => view({ version: 4 }));
    await data("update_lane", setup({ get, update }), {
      laneId: LANE,
      changeDescription: "Run on the DevBox with Claude Code",
      expectedVersion: 3,
      edits: [
        { path: "/steps/0/runner", value: "r-devbox" },
        { path: "/steps/0/harness", value: "claude-code" },
        {
          path: "/steps/0/model",
          value: { provider: "claude-code", model: "sonnet" },
        },
      ],
    });
    expect(get).toHaveBeenCalledWith(LANE, 3);
    expect(update).toHaveBeenCalledWith(
      { id: "user-ada" },
      LANE,
      {
        name: "Issue to PR",
        steps: [
          {
            id: "a",
            runner: "r-devbox",
            harness: "claude-code",
            model: { provider: "claude-code", model: "sonnet" },
          },
        ],
        changeDescription: "Run on the DevBox with Claude Code",
      },
      3,
    );
  });

  // #1145-T14
  it("refuses document and edits together or neither, and edits without expectedVersion, without asking the service", async () => {
    const service = { get: vi.fn(), update: vi.fn() };
    const context = setup(service);
    for (const args of [
      { document: {}, edits: [{ path: "/a", value: 1 }] },
      {},
      { edits: [{ path: "/a", value: 1 }] },
    ])
      expect(
        await failure("update_lane", context, {
          laneId: LANE,
          changeDescription: "x",
          ...args,
        }),
      ).toMatchObject({ error: "invalid_input" });
    expect(service.get).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  // #1145-T15
  it("requires a change note and refuses an empty one before the service", async () => {
    const update = vi.fn();
    expect(
      await failure("update_lane", setup({ update }), {
        laneId: LANE,
        document: {},
      }),
    ).toMatchObject({ error: "invalid_input" });
    expect(
      await failure("update_lane", setup({ update }), {
        laneId: LANE,
        document: {},
        changeDescription: "",
      }),
    ).toMatchObject({ error: "invalid_input" });
    expect(update).not.toHaveBeenCalled();
  });

  // #1145-T16
  it("answers a stale expectedVersion as conflict with the current version, and a bad edit path as invalid_input", async () => {
    const stale = await failure(
      "update_lane",
      setup({
        update: async () => {
          throw refuse("WORKFLOW_VERSION_CONFLICT", { current: 5 });
        },
      }),
      {
        laneId: LANE,
        document: {},
        changeDescription: "x",
        expectedVersion: 3,
      },
    );
    expect(stale).toMatchObject({ error: "conflict", current: 5 });
    const update = vi.fn();
    const bad = await failure(
      "update_lane",
      setup({ get: async () => view(), update }),
      {
        laneId: LANE,
        changeDescription: "x",
        expectedVersion: 3,
        edits: [{ path: "/steps/7/runner", value: "r" }],
      },
    );
    expect(bad).toMatchObject({ error: "invalid_input" });
    expect(update).not.toHaveBeenCalled();
  });

  // #1145-T17
  it("is for Owners and Admins: a member is forbidden, an admin is let through", async () => {
    const update = vi.fn(async () => view());
    const args = { laneId: LANE, document: {}, changeDescription: "x" };
    expect(
      await failure("update_lane", setup({ update }, { role: "member" }), args),
    ).toMatchObject({ error: "forbidden" });
    await data("update_lane", setup({ update }, { role: "admin" }), args);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("restore_lane_version and archive_lane", () => {
  // #1145-T18
  it("saves the old document as a new version with a default change note", async () => {
    const get = vi.fn(async () =>
      view({ documentVersion: 2, document: { name: "Old", steps: [] } }),
    );
    const update = vi.fn(async () => view({ version: 4 }));
    await data("restore_lane_version", setup({ get, update }), {
      laneId: LANE,
      version: 2,
      expectedVersion: 3,
    });
    expect(get).toHaveBeenCalledWith(LANE, 2);
    expect(update).toHaveBeenCalledWith(
      { id: "user-ada" },
      LANE,
      { name: "Old", steps: [], changeDescription: "Restored version 2" },
      3,
    );
  });

  // #1145-T19
  it("answers an old version that no longer validates with every problem, and an archived lane as conflict", async () => {
    const errors = [
      {
        path: "/steps/0/runner",
        code: "runner_unknown" as const,
        message: "gone",
      },
    ];
    const get = async () => view();
    expect(
      await failure(
        "restore_lane_version",
        setup({
          get,
          update: async () => {
            throw refuse("WORKFLOW_INVALID", { errors });
          },
        }),
        { laneId: LANE, version: 1 },
      ),
    ).toMatchObject({ error: "invalid_input", errors });
    expect(
      await failure(
        "restore_lane_version",
        setup({
          get,
          update: async () => {
            throw refuse("WORKFLOW_ARCHIVED");
          },
        }),
        { laneId: LANE, version: 1, changeDescription: "back" },
      ),
    ).toMatchObject({ error: "conflict" });
  });

  // #1145-T20
  it("archives a lane, for Owners and Admins, and limits are limit_reached", async () => {
    const archive = vi.fn(async () =>
      view({ archivedAt: "2026-11-25T10:00:00.000Z" }),
    );
    const answer = await data("archive_lane", setup({ archive }), {
      laneId: LANE,
    });
    expect(archive).toHaveBeenCalledWith(LANE);
    expect(answer).toMatchObject({
      lane: { archivedAt: "2026-11-25T10:00:00.000Z" },
    });
    expect(
      await failure("archive_lane", setup({ archive }, { role: "member" }), {
        laneId: LANE,
      }),
    ).toMatchObject({ error: "forbidden" });
    expect(
      await failure(
        "archive_lane",
        setup({
          archive: async () => {
            throw refuse("WORKFLOW_ARCHIVE_LIMIT_REACHED", { maximum: 50 });
          },
        }),
        { laneId: LANE },
      ),
    ).toMatchObject({ error: "limit_reached", maximum: 50 });
  });

  // #1145-T21
  it("does not let an error that is no refusal of the service reach the client", async () => {
    const fail = await failure(
      "get_lane",
      setup({
        get: async () => {
          throw new Error("postgres://secret");
        },
      }),
      { laneId: LANE },
    );
    expect(fail.error).toBe("internal_error");
    expect(JSON.stringify(fail)).not.toContain("secret");
  });
});

describe("edits of a lane document", () => {
  const base = { name: "x", steps: [{ id: "a", tags: ["t"] }] };

  // #1145-T22
  it("replaces, adds, removes and appends, on a copy", () => {
    const copy = applyEdits(base, [
      { path: "/name", value: "y" },
      { path: "/steps/0/runner", value: "r1" },
      { path: "/steps/0/tags/-", value: "u" },
      { path: "/steps/0/tags/0" },
      { path: "/steps/-", value: { id: "b" } },
    ]);
    expect(copy).toEqual({
      name: "y",
      steps: [{ id: "a", runner: "r1", tags: ["u"] }, { id: "b" }],
    });
    expect(base).toEqual({ name: "x", steps: [{ id: "a", tags: ["t"] }] });
  });

  // #1145-T23
  it("understands ~0 and ~1", () => {
    expect(
      applyEdits({ "a/b": { "c~d": 1 } }, [{ path: "/a~1b/c~0d", value: 2 }]),
    ).toEqual({
      "a/b": { "c~d": 2 },
    });
  });

  // #1145-T24
  it.each([
    "name",
    "",
    "/",
    "/nothing/here",
    "/steps/5/id",
    "/steps/x/id",
    "/__proto__/polluted",
    "/steps/0/constructor",
  ])("refuses the path %j", (path) => {
    expect(() => applyEdits(base, [{ path, value: 1 }])).toThrowError();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("the real lane service behind the tools", () => {
  const HOSTED: NamedRunner = {
    kind: "hosted",
    id: "h-4",
    name: "Vercel Sandbox 4 vCPU",
    vcpus: 4,
    concurrency: 2,
  };
  const DEVBOX: NamedRunner = {
    kind: "self_hosted",
    id: "r-devbox",
    name: "DevBox",
    labels: [],
    baseVersion: "1.0.0",
    manifest: { harnesses: [], capabilities: [] },
    limits: {},
    lastSeenAt: "2026-11-21T00:00:00.000Z",
    revokedAt: null,
  };

  function laneDocument(runner: string, harness?: string) {
    return {
      version: 1,
      name: "Real",
      description: "Does a thing.",
      trigger: {
        kind: "manual",
        input: {
          type: "object",
          required: ["repo"],
          properties: { repo: { type: "string" } },
        },
      },
      steps: [
        {
          id: "work",
          kind: "agent",
          model:
            harness === "claude-code"
              ? { provider: "claude-code", model: "sonnet" }
              : { provider: "anthropic", model: "claude-sonnet-5-5" },
          ...(harness === undefined ? {} : { harness }),
          canPush: false,
          runner,
          instruction: "Do it.",
        },
      ],
    };
  }

  /** The lane service over an in-memory store of versions. */
  function realService() {
    const versions: StoredWorkflowVersion[] = [];
    let workflow: StoredWorkflow = {
      id: LANE,
      workspaceId: "ws-acme",
      projectId: "p1",
      name: "Real",
      version: 1,
      createdBy: "u0",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      archivedAt: null,
    };
    versions.push({
      workflowId: LANE,
      version: 1,
      document: JSON.stringify(laneDocument("h-4")),
      createdBy: "u0",
      createdAt: "2026-11-01T00:00:00.000Z",
      changeDescription: null,
    });
    const workflows = {
      get: async () => ({
        workflow,
        current: versions[versions.length - 1] as StoredWorkflowVersion,
      }),
      getVersion: async (_id: string, version: number) =>
        versions.find((v) => v.version === version),
      listVersions: async () =>
        [...versions].reverse().map((v) => ({
          version: v.version,
          createdAt: v.createdAt,
          createdBy: v.createdBy,
          changeDescription: v.changeDescription,
        })),
      saveVersion: async (
        _id: string,
        input: {
          document: string;
          changeDescription?: string;
          createdBy: string;
          expectedVersion?: number;
          name: string;
        },
      ) => {
        if (
          input.expectedVersion !== undefined &&
          input.expectedVersion !== workflow.version
        )
          return {
            ok: false as const,
            reason: "version_conflict" as const,
            current: workflow.version,
          };
        const saved: StoredWorkflowVersion = {
          workflowId: LANE,
          version: workflow.version + 1,
          document: input.document,
          createdBy: input.createdBy,
          createdAt: "2026-11-25T10:00:00.000Z",
          changeDescription: input.changeDescription ?? null,
        };
        versions.push(saved);
        workflow = { ...workflow, version: saved.version };
        return { ok: true as const, workflow, saved };
      },
    } as unknown as WorkflowsRepository;
    return createWorkflowService({
      workflows,
      projects: {} as never,
      environments: { listSummaries: async () => [] } as never,
      profiles: {
        list: async () => [],
        versionFacts: async () => [],
        archivedNames: async () => [],
      } as never,
      runners: {
        list: async () => [HOSTED, DEVBOX],
        find: async () => undefined,
      },
      claudeCodeTokenConfigured: async () => false,
    });
  }

  // #1145-T25
  it("switches a step to a self-hosted runner and the harness claude-code through edits, and keeps the old version", async () => {
    const context = setup(realService());
    const saved = await data("update_lane", context, {
      laneId: LANE,
      changeDescription: "DevBox with Claude Code",
      expectedVersion: 1,
      edits: [
        { path: "/steps/0/runner", value: "r-devbox" },
        { path: "/steps/0/harness", value: "claude-code" },
        {
          path: "/steps/0/model",
          value: { provider: "claude-code", model: "sonnet" },
        },
      ],
    });
    expect(saved).toMatchObject({ lane: { version: 2, documentVersion: 2 } });
    const now = await data("get_lane", context, { laneId: LANE });
    expect(
      (now.lane as { document: { steps: unknown[] } }).document.steps[0],
    ).toMatchObject({
      runner: "r-devbox",
      harness: "claude-code",
    });
    const listed = await data("list_lane_versions", context, { laneId: LANE });
    expect(
      (
        listed.versions as {
          version: number;
          changeDescription: string | null;
        }[]
      ).map((v) => [v.version, v.changeDescription]),
    ).toEqual([
      [2, "DevBox with Claude Code"],
      [1, null],
    ]);
    const restored = await data("restore_lane_version", context, {
      laneId: LANE,
      version: 1,
    });
    expect(restored).toMatchObject({ lane: { version: 3 } });
    expect(
      (
        (await data("get_lane", context, { laneId: LANE })).lane as {
          document: { steps: { runner: string }[] };
        }
      ).document.steps[0]?.runner,
    ).toBe("h-4");
  });

  // #1145-T26
  it("refuses a hosted runner with the harness claude-code (no token) and an unknown runner id, with every problem and the ids that exist", async () => {
    const context = setup(realService());
    const fail = await failure("update_lane", context, {
      laneId: LANE,
      changeDescription: "x",
      expectedVersion: 1,
      edits: [
        { path: "/steps/0/runner", value: "nowhere" },
        { path: "/steps/0/harness", value: "claude-code" },
        {
          path: "/steps/0/model",
          value: { provider: "claude-code", model: "sonnet" },
        },
      ],
    });
    expect(fail).toMatchObject({
      error: "invalid_input",
      code: "WORKFLOW_INVALID",
    });
    const errors = fail.errors as { code: string; available?: string[] }[];
    expect(errors.find((e) => e.code === "runner_unknown")?.available).toEqual([
      "h-4",
      "r-devbox",
    ]);
    const hosted = await failure("update_lane", context, {
      laneId: LANE,
      changeDescription: "x",
      document: laneDocument("h-4", "claude-code"),
    });
    expect((hosted.errors as { code: string }[]).map((e) => e.code)).toContain(
      "harness_needs_runner",
    );
    // nothing was saved
    expect(
      (await data("get_lane", context, { laneId: LANE })).lane,
    ).toMatchObject({ version: 1 });
  });

  // #1145-T27
  it("answers a save over a newer version as conflict with the current one, and a document without a change note's tool arguments is refused", async () => {
    const context = setup(realService());
    await data("update_lane", context, {
      laneId: LANE,
      changeDescription: "one",
      document: laneDocument("r-devbox"),
      expectedVersion: 1,
    });
    expect(
      await failure("update_lane", context, {
        laneId: LANE,
        changeDescription: "two",
        document: laneDocument("h-4"),
        expectedVersion: 1,
      }),
    ).toMatchObject({ error: "conflict", current: 2 });
  });

  // #1145-T28
  it("validates through the real validator and answers the problems of a document as a normal answer", async () => {
    const answer = await data("validate_lane", setup(realService()), {
      document: laneDocument("nowhere"),
    });
    expect(answer).toMatchObject({ valid: false });
    expect((answer.errors as { code: string }[]).map((e) => e.code)).toContain(
      "runner_unknown",
    );
    expect(
      await data("validate_lane", setup(realService()), {
        document: laneDocument("r-devbox"),
      }),
    ).toMatchObject({ valid: true, errors: [] });
  });
});
