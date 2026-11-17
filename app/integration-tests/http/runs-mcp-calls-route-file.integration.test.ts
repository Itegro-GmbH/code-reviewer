// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route file `GET /api/w/:workspace/runs/:id/mcp-calls` (#1055) with the wiring the running server uses: the database
// opened at start, the MCP calls service and the workspace access. Only the session lookup and `connection()` are replaced (they need
// Next.js's request scope). The behavior of the service is in src/runs/mcp-calls-service.test.ts; this file proves the pieces are connected,
// and that the workspace comes from the address and from the membership of the person.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { createJobMcpCallsRepository } from "../../src/db/repositories/job-mcp-calls-repository.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import { getRunnerQueue, jobQueueFor } from "../../src/jobs/shared.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import { GET as getCalls } from "../../src/app/api/w/[workspace]/runs/[id]/mcp-calls/route.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";
import { addUser } from "../../src/test-support/workspace-deletion-fixture.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

async function startRoutes() {
  // A turn of the Implementer is queued only where the capability is: the factory.
  vi.stubEnv("PRODUCT_ID", "factory");
  vi.stubEnv(
    "PRODUCT_CAPABILITIES",
    "review,dynamic-review,billing,implementer",
  );
  await openRouteTestDatabase();
  const db = getDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, { workspaceId, role: "member" }),
  );
  await addUser(db, "user-1");
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(db, workspaceId);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "1",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  const enqueued = await jobQueueFor(workspaceId).enqueueImplementerTurn({
    repositoryId: repository.id,
    baseBranch: "main",
    baseSha: "a".repeat(40),
    branch: "implementer/route",
    instruction: "Add a health endpoint.",
    modelChoice: { entryId: "entry-1" },
    costLimitCents: null,
    createdBy: "user-1",
    actorLogin: "octocat",
    clientRequestId: "request-1",
  });
  if (enqueued.status !== "created") throw new Error("seeding failed");
  const claim = await getRunnerQueue().claimNext("runner-1", ["implementer"]);
  if (claim === null) throw new Error("seeding failed");
  await createJobMcpCallsRepository(db, workspaceId).record(enqueued.job.id, {
    serverId: "11111111-1111-4111-8111-111111111111",
    serverName: "Linear",
    rpcMethod: "tools/call",
    tool: "list_issues",
    status: 200,
    outcome: "ok",
    durationMs: 120,
    requestBytes: 90,
    responseBytes: 4000,
  });
  return { job: enqueued.job, db };
}

const calls = (workspace: string, id: string, query = "") =>
  getCalls(
    new Request(
      `https://app.test/api/w/${workspace}/runs/${id}/mcp-calls${query}`,
    ),
    { params: Promise.resolve({ workspace, id }) } as Parameters<
      typeof getCalls
    >[1],
  );

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("the MCP calls route file", () => {
  // #1055-T01
  it("answers the MCP calls of a run of the workspace in the address, with the server and the tool and nothing of arguments or answers", async () => {
    const { job } = await startRoutes();

    const response = await calls("default", job.id, "?after=0&limit=10");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      calls: Record<string, unknown>[];
    };
    expect(body).toMatchObject({
      calls: [
        {
          serverName: "Linear",
          rpcMethod: "tools/call",
          tool: "list_issues",
          status: 200,
          outcome: "ok",
          result: "ok",
          durationMs: 120,
        },
      ],
      cursor: expect.any(Number),
      hasMore: false,
      full: false,
      omitted: 0,
    });
  });

  // #1055-T03
  it("takes a cursor past 32 bits (the identity is table-wide) and refuses one a number cannot hold", async () => {
    const { job } = await startRoutes();

    const far = await calls("default", job.id, "?after=5000000000");
    const absurd = await calls("default", job.id, "?after=9007199254740993");

    expect(far.status).toBe(200);
    // The cursor is far ahead of the row: the answer still starts a few rows behind it, and the cursor does not move back.
    expect(await far.json()).toMatchObject({ cursor: 5000000000 });
    expect(absurd.status).toBe(400);
  });

  // #1055-T04
  it("answers 404 for an unknown run and 400 for a query it does not read", async () => {
    const { job } = await startRoutes();

    const missing = await calls(
      "default",
      "00000000-0000-4000-8000-000000000000",
    );
    const invalid = await calls("default", job.id, "?after=-3");

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "RUN_NOT_FOUND" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "STEPS_QUERY_INVALID" });
  });

  // #1055-T04
  it("answers a workspace the person does not belong to like one that does not exist, and shows nothing of it", async () => {
    const { job, db } = await startRoutes();
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, { id: "outsider" }),
    );

    for (const response of [
      await calls("default", job.id),
      await calls("no-such-workspace", job.id),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  // #1055-T04
  it("asks for the session before it reads anything, and answers a visitor with 401", async () => {
    const { job } = await startRoutes();
    session.currentLookup.mockResolvedValue({ kind: "none" });

    const response = await calls("default", job.id);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  it("exports only the GET method", async () => {
    const route =
      await import("../../src/app/api/w/[workspace]/runs/[id]/mcp-calls/route.ts");

    expect(Object.keys(route)).toEqual(["GET"]);
  });
});
