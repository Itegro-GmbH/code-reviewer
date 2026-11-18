// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route file behind the list of the lane runs of a workspace (#1078) with the wiring the running server uses: the
// workspace in the address, the database opened at start and the access of a Member. Only the session lookup and `connection()` are
// replaced. The ordering, paging and filters of the list are proved in
// src/db/repositories/workflow-runs-workspace-list.integration.test.ts; this file proves the pieces are connected: the same access as the
// other workflow-run routes, a stranger sees 404, another workspace's runs never show, a filter that is none is a 400, and a deployment
// without the capability has no such path.
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

const DOCUMENT = {
  version: 1,
  name: "Run me",
  trigger: { kind: "manual", input: { type: "object", properties: {} } },
  steps: [
    { id: "work", kind: "agent", profile: "worker", environment: "Python" },
  ],
};

async function startRoute(
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
  const route =
    await import("../../src/app/api/w/[workspace]/workflow-runs/route.ts");

  const runIn = async (id: string, seeded: typeof seed, request: string) => {
    const made = await createWorkflowsRepository(db, id).create(
      {
        name: "Run me",
        document: JSON.stringify(DOCUMENT),
        createdBy: seeded.userId,
      },
      100,
    );
    if (!made.ok) throw new Error("seeding failed");
    const created = await createWorkflowRunsRepository(db, id).createRun({
      workflowId: made.workflow.id,
      workflowVersion: 1,
      repositoryId: seeded.repositoryId,
      baseBranch: "main",
      triggerInput: "{}",
      budgetMicroUsd: 20_000_000,
      clientRequestId: request,
      createdBy: seeded.userId,
      actorLogin: "octocat",
    });
    return { workflow: made.workflow, run: created.run };
  };
  const list = (query = "", workspace = "default") =>
    route.GET(
      new Request(`https://app.test/api/w/${workspace}/workflow-runs${query}`),
      { params: Promise.resolve({ workspace }) } as Parameters<
        typeof route.GET
      >[1],
    );
  return { db, workspaceId, otherId, seed, otherSeed, route, runIn, list };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("the workspace workflow runs route file", () => {
  // #1078-T120
  it("lets a Member read the runs of the workspace with their lane, project and nodes", async () => {
    const { workspaceId, seed, runIn, list } = await startRoute({
      role: "member",
    });
    const { workflow, run } = await runIn(workspaceId, seed, "req-1");

    const response = await list();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      runs: [
        {
          id: run.id,
          workflowId: workflow.id,
          laneName: "Run me",
          status: "running",
          project: { id: seed.repositoryId },
          nodes: [{ id: "work", kind: "agent" }],
          steps: [],
          budgetUsd: 20,
        },
      ],
      nextCursor: null,
    });
  });

  // #1078-T121
  it("keeps the workspaces apart: another workspace's runs are not in the list, and a stranger sees 404", async () => {
    const { otherId, otherSeed, runIn, list } = await startRoute({
      role: "owner",
    });
    await runIn(otherId, otherSeed, "req-b");

    const own = await list();
    const stranger = await list("", "other");

    expect(await own.json()).toMatchObject({ runs: [] });
    // The signed in person is no member of "other": the workspace is not there for them.
    expect(stranger.status).toBe(404);
  });

  // #1078-T122
  it("answers a filter that is none with a 400 and its stable code", async () => {
    const { list } = await startRoute();

    for (const query of ["?status=everything", "?limit=0", "?cursor=nope"]) {
      const response = await list(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "WORKFLOW_RUN_REQUEST_INVALID",
      });
    }
  });

  // #1078-T123
  it.each(["factoryToday", "codeReviewCom"] as const)(
    "answers the 404 of a path that does not exist in a deployment without the capability (%s), before the session is asked",
    async (deployment) => {
      const { list } = await startRoute({ deployment });
      session.currentLookup.mockClear();
      session.currentLookup.mockResolvedValue({ kind: "none" });

      await expect(list()).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
      expect(session.currentLookup).not.toHaveBeenCalled();
    },
  );

  // #1078-T124
  it("exports only GET", async () => {
    const { route } = await startRoute();

    expect(Object.keys(route).sort()).toEqual(["GET"]);
  });
});
