// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route files behind the workflow run API (#844) with the wiring the running server uses: the dynamic segments, the
// database opened at start and the workspace access. Only the session lookup and `connection()` are replaced (they need Next.js's
// request scope). The service's rules are in src/workflow-runs/engine.integration.test.ts; this file proves the pieces are connected:
// a Member may start and read runs, the workspace is the one in the address, a stranger sees 404, and a deployment without the
// capability has no such path. A start that would reach GitHub is not made here (no real network in a test): the refusals before it are.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { createWorkflowRunsRepository } from "../../src/db/repositories/workflow-runs-repository.ts";
import { createWorkflowsRepository } from "../../src/db/repositories/workflows-repository.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import type { WorkspaceRole } from "../../src/db/workspace-roles.ts";
import { seedImplementerRepository } from "../../src/test-support/implementer.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../src/test-support/workspaces.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const DEPLOYMENTS = {
  withCapability: {
    PRODUCT_ID: "factory",
    PRODUCT_CAPABILITIES: "review,dynamic-review,implementer",
  },
  factoryToday: {
    PRODUCT_ID: "factory",
    PRODUCT_CAPABILITIES: "review,dynamic-review",
  },
  codeReviewCom: { PRODUCT_ID: "code-review-com" },
} as const;

const MANUAL = {
  kind: "manual",
  input: {
    type: "object",
    required: ["repo"],
    properties: { repo: { type: "string" } },
  },
};
const WORKFLOW = {
  version: 1,
  name: "Run me",
  trigger: MANUAL,
  steps: [
    {
      id: "work",
      kind: "agent",
      profile: "worker",
      environment: "Python",
      instruction: "Work.",
    },
  ],
};

async function startRoutes(
  options: { role?: WorkspaceRole; deployment?: keyof typeof DEPLOYMENTS } = {},
) {
  for (const [name, value] of Object.entries(
    DEPLOYMENTS[options.deployment ?? "withCapability"],
  ))
    vi.stubEnv(name, value);
  await openRouteTestDatabase();
  const db = getDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const otherId = await addWorkspace(db, "other");
  const seed = await seedImplementerRepository(db, workspaceId, "a");
  const otherSeed = await seedImplementerRepository(db, otherId, "b");
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, {
      workspaceId,
      role: options.role ?? "member",
      githubLogin: "octocat",
    }),
  );
  const listRoute =
    await import("../../src/app/api/w/[workspace]/workflows/[workflowId]/runs/route.ts");
  const itemRoute =
    await import("../../src/app/api/w/[workspace]/workflows/[workflowId]/runs/[runId]/route.ts");

  const workflowIn = async (
    id: string,
    userId: string,
    document: unknown = WORKFLOW,
    name = "Run me",
  ) => {
    const made = await createWorkflowsRepository(db, id).create(
      { name, document: JSON.stringify(document), createdBy: userId },
      100,
    );
    if (!made.ok) throw new Error("seeding failed");
    return made.workflow;
  };
  const runIn = async (
    id: string,
    seeded: typeof seed,
    workflowId: string,
    request: string,
  ) => {
    const runs = createWorkflowRunsRepository(db, id);
    const made = await runs.createRun({
      workflowId,
      workflowVersion: 1,
      repositoryId: seeded.repositoryId,
      baseBranch: "main",
      triggerInput: '{"repo":"acme/x"}',
      budgetMicroUsd: 20_000_000,
      clientRequestId: request,
      createdBy: seeded.userId,
      actorLogin: "octocat",
    });
    await runs.lockRun(made.run.id, (lock) =>
      lock.addStep({
        position: 0,
        stepId: "work",
        kind: "action",
        profile: null,
        capMicroUsd: null,
      }),
    );
    return made.run;
  };

  const base = (workspace: string, workflowId: string) =>
    `https://app.test/api/w/${workspace}/workflows/${workflowId}/runs`;
  const start = (
    workflowId: string,
    body: unknown,
    workspace = "default",
    headers: Record<string, string> = {},
  ) =>
    listRoute.POST(
      new Request(base(workspace, workflowId), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      {
        params: Promise.resolve({ workspace, workflowId }),
      } as Parameters<typeof listRoute.POST>[1],
    );
  const list = (workflowId: string, workspace = "default") =>
    listRoute.GET(new Request(base(workspace, workflowId)), {
      params: Promise.resolve({ workspace, workflowId }),
    } as Parameters<typeof listRoute.GET>[1]);
  const get = (workflowId: string, runId: string, workspace = "default") =>
    itemRoute.GET(new Request(`${base(workspace, workflowId)}/${runId}`), {
      params: Promise.resolve({ workspace, workflowId, runId }),
    } as Parameters<typeof itemRoute.GET>[1]);
  const runs = () => db.selectFrom("workflow_runs").selectAll().execute();
  return {
    db,
    workspaceId,
    otherId,
    seed,
    otherSeed,
    listRoute,
    itemRoute,
    workflowIn,
    runIn,
    start,
    list,
    get,
    runs,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("the workflow run route files", () => {
  // #844-T150
  it("let a Member read the runs of a workflow and one run with its steps", async () => {
    const { workspaceId, seed, workflowIn, runIn, list, get } =
      await startRoutes({ role: "member" });
    const workflow = await workflowIn(workspaceId, seed.userId);
    const run = await runIn(workspaceId, seed, workflow.id, "req-1");

    const listed = await list(workflow.id);
    const read = await get(workflow.id, run.id);

    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toMatchObject({
      runs: [
        {
          id: run.id,
          workflowId: workflow.id,
          status: "running",
          budgetUsd: 20,
          spentUsd: 0,
        },
      ],
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      run: {
        id: run.id,
        input: { repo: "acme/x" },
        steps: [
          { id: "work", kind: "action", status: "pending", output: null },
        ],
      },
    });
    // A run is read through its own workflow only.
    const other = await workflowIn(workspaceId, seed.userId, WORKFLOW, "Other");
    expect((await get(other.id, run.id)).status).toBe(404);
    expect((await get(workflow.id, "nope")).status).toBe(404);
  });

  // #844-T151
  it("refuse a start before anything is written: an unknown workflow, an archived one, a body that is no request, an input that does not fit, a repository that is none of the workspace's", async () => {
    const { workspaceId, seed, workflowIn, start, runs, db } =
      await startRoutes();
    const workflow = await workflowIn(workspaceId, seed.userId);

    const unknown = await start("nope", {
      input: { repo: "a/b" },
      clientRequestId: "r1",
    });
    const noId = await start(workflow.id, { input: { repo: "a/b" } });
    const extra = await start(workflow.id, {
      input: { repo: "a/b" },
      clientRequestId: "r1",
      budget: 1000,
    });
    const badInput = await start(workflow.id, {
      input: { repo: 3 },
      clientRequestId: "r1",
    });
    const stranger = await start(workflow.id, {
      input: { repo: "evil/other" },
      clientRequestId: "r1",
    });
    await db
      .updateTable("workflows")
      .set({ archived_at: "2026-11-05T09:00:00.000Z" })
      .where("id", "=", workflow.id)
      .execute();
    const archived = await start(workflow.id, {
      input: { repo: "a/b" },
      clientRequestId: "r1",
    });

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      error: "WORKFLOW_RUN_WORKFLOW_NOT_FOUND",
    });
    expect(noId.status).toBe(400);
    expect(await noId.json()).toMatchObject({
      error: "WORKFLOW_RUN_REQUEST_INVALID",
    });
    expect(extra.status).toBe(400);
    expect(badInput.status).toBe(422);
    expect(await badInput.json()).toMatchObject({
      error: "WORKFLOW_RUN_INPUT_INVALID",
      errors: [{ path: "/repo", code: "wrong_type" }],
    });
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toMatchObject({
      error: "WORKFLOW_RUN_REPOSITORY_NOT_FOUND",
    });
    expect(archived.status).toBe(409);
    expect(await archived.json()).toMatchObject({
      error: "WORKFLOW_RUN_WORKFLOW_ARCHIVED",
    });
    expect(await runs()).toEqual([]);
  });

  // #844-T152
  it("refuse a body that is not JSON, one of another type, and a request from another site", async () => {
    const { workspaceId, seed, workflowIn, listRoute, runs } =
      await startRoutes();
    const workflow = await workflowIn(workspaceId, seed.userId);
    const call = (init: RequestInit) =>
      listRoute.POST(
        new Request(
          `https://app.test/api/w/default/workflows/${workflow.id}/runs`,
          { method: "POST", ...init },
        ),
        {
          params: Promise.resolve({
            workspace: "default",
            workflowId: workflow.id,
          }),
        } as Parameters<typeof listRoute.POST>[1],
      );

    const text = await call({
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    const broken = await call({
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const crossSite = await call({
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: "{}",
    });

    expect(text.status).toBe(415);
    expect(broken.status).toBe(400);
    expect(crossSite.status).toBe(403);
    expect(await runs()).toEqual([]);
  });

  // #844-T153
  it("keep the workspaces apart: another workspace's workflow and run cannot be started or read by id, and a stranger sees 404", async () => {
    const { otherId, otherSeed, workflowIn, runIn, start, list, get, runs } =
      await startRoutes({ role: "owner" });
    const foreign = await workflowIn(otherId, otherSeed.userId);
    const foreignRun = await runIn(otherId, otherSeed, foreign.id, "req-b");

    expect((await list(foreign.id)).status).toBe(404);
    expect((await get(foreign.id, foreignRun.id)).status).toBe(404);
    const started = await start(foreign.id, {
      input: { repo: "acme/b" },
      clientRequestId: "req-x",
    });
    expect(started.status).toBe(404);
    // The signed in person is no member of "other": the workspace is not there for them.
    for (const response of [
      await list(foreign.id, "other"),
      await get(foreign.id, foreignRun.id, "other"),
      await start(
        foreign.id,
        { input: { repo: "acme/b" }, clientRequestId: "req-y" },
        "other",
      ),
    ])
      expect(response.status).toBe(404);
    expect(await runs()).toHaveLength(1);
  });

  // #844-T154
  it.each(["factoryToday", "codeReviewCom"] as const)(
    "answer the 404 of a path that does not exist in a deployment without the capability (%s), before the session or the database is asked",
    async (deployment) => {
      const { start, list, get, runs } = await startRoutes({ deployment });
      session.currentLookup.mockClear();
      session.currentLookup.mockResolvedValue({ kind: "none" });

      for (const call of [
        () => start("x", { input: {}, clientRequestId: "r" }),
        () => list("x"),
        () => get("x", "y"),
      ])
        await expect(call()).rejects.toMatchObject({
          digest: "NEXT_HTTP_ERROR_FALLBACK;404",
        });
      expect(session.currentLookup).not.toHaveBeenCalled();
      expect(await runs()).toEqual([]);
    },
  );

  // #844-T155
  it("export only the methods each route serves", async () => {
    const { listRoute, itemRoute } = await startRoutes();

    expect(Object.keys(listRoute).sort()).toEqual(["GET", "POST"]);
    expect(Object.keys(itemRoute).sort()).toEqual(["GET"]);
  });
});
