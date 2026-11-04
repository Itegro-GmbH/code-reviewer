// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route file `GET /api/w/:workspace/runs/:id/steps` (#745, live view) with the wiring the running server uses:
// the database opened at start, the steps service and the workspace access. Only the session lookup and `connection()` are
// replaced (they need Next.js's request scope). The behavior of the handler is in src/runs/steps-service.integration.test.ts; this
// file proves the pieces are connected, and that the workspace comes from the address and from the membership of the person.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { createImplementerStepsRepository } from "../../src/db/repositories/implementer-steps-repository.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import { getRunnerQueue, jobQueueFor } from "../../src/jobs/shared.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import { GET as getSteps } from "../../src/app/api/w/[workspace]/runs/[id]/steps/route.ts";
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
  await createImplementerStepsRepository(db, workspaceId).recordSteps(
    enqueued.job.id,
    claim.leaseToken,
    [
      {
        partId: "prt_1",
        seq: 1,
        kind: "text",
        payload: { text: "Reading the code." },
      },
    ],
  );
  return { job: enqueued.job, db };
}

const steps = (workspace: string, id: string, query = "") =>
  getSteps(
    new Request(`https://app.test/api/w/${workspace}/runs/${id}/steps${query}`),
    { params: Promise.resolve({ workspace, id }) } as Parameters<
      typeof getSteps
    >[1],
  );

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("the steps route file", () => {
  // #745-T49
  it("answers the steps of a run of the workspace in the address", async () => {
    const { job } = await startRoutes();

    const response = await steps("default", job.id, "?after=0&limit=10");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      steps: [
        {
          partId: "prt_1",
          seq: 1,
          ordinal: 1,
          kind: "text",
          text: "Reading the code.",
        },
      ],
      cursor: 1,
      hasMore: false,
    });
  });

  // #745-T50
  it("answers 404 for an unknown run and 400 for a query it does not read", async () => {
    const { job } = await startRoutes();

    const missing = await steps(
      "default",
      "00000000-0000-4000-8000-000000000000",
    );
    const invalid = await steps("default", job.id, "?after=-3");

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "RUN_NOT_FOUND" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "STEPS_QUERY_INVALID" });
  });

  // #745-T51
  it("answers a workspace the person does not belong to like one that does not exist, and shows nothing of it", async () => {
    const { job, db } = await startRoutes();
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, { id: "outsider" }),
    );

    for (const response of [
      await steps("default", job.id),
      await steps("no-such-workspace", job.id),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  // #745-T52
  it("asks for the session before it reads anything, and answers a visitor with 401", async () => {
    const { job } = await startRoutes();
    session.currentLookup.mockResolvedValue({ kind: "none" });

    const response = await steps("default", job.id);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  it("exports only the GET method", async () => {
    const route =
      await import("../../src/app/api/w/[workspace]/runs/[id]/steps/route.ts");

    expect(Object.keys(route)).toEqual(["GET"]);
  });
});
