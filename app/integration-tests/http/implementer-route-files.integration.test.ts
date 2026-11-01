// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route files behind the Implementer form (#755) with the wiring the running server uses: the dynamic
// segments, the database opened at start, the registry configured from the environment (the real GitHub App client against the fake
// GitHub), the workspace's key store and the models.dev catalog, the job queue and the workspace access. Only the session lookup and
// `connection()` are replaced (they need Next.js's request scope). The behaviour of the handlers is in
// src/implementer/http.integration.test.ts; this file proves the pieces are connected, that every member may send a task, and that the
// workspace is the one in the address.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startGithubFake,
  type FakeGithub,
} from "../../../fakes/github/server.ts";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createModelsDevRepository } from "../../src/db/repositories/models-dev-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import {
  TEST_APP_ID,
  testAppKeys,
  testGithubAppEnv,
} from "../../src/test-support/github-app.ts";
import { saveGithubAppFromEnv } from "../../src/test-support/server-credentials.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";
import type { WorkspaceRole } from "../../src/db/workspace-roles.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const APP_SECRET = "implementer-routes-secret-0123456789-0123456789";
const DEEPSEEK_KEY = "sk-deepseek-dummy-0123456789abcdef0123456789abcdef";
const WRITE = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "write",
} as const;
const fakes: FakeGithub[] = [];

const T = "2026-10-19T03:00:00.000Z";

/** The deployments the routes are tested in: the factory with the capability, and the ones without it. */
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

async function startRoutes(
  options: {
    role?: WorkspaceRole;
    accepted?: typeof WRITE;
    deployment?: keyof typeof DEPLOYMENTS;
  } = {},
) {
  for (const [name, value] of Object.entries(
    DEPLOYMENTS[options.deployment ?? "withCapability"],
  ))
    vi.stubEnv(name, value);
  vi.stubEnv("APP_SECRET", APP_SECRET);
  const fake = await startGithubFake({
    appId: TEST_APP_ID,
    publicKeyPem: testAppKeys().publicKey,
  });
  fakes.push(fake);
  const env = testGithubAppEnv({
    GITHUB_API_BASE_URL: fake.baseUrl,
    ALLOW_TEST_GITHUB_ENDPOINTS: "true",
  });
  for (const [name, value] of Object.entries(env))
    if (value !== undefined) vi.stubEnv(name, value);
  await openRouteTestDatabase();
  const db = getDatabase();
  await saveGithubAppFromEnv(db, env);
  const workspaceId = await defaultWorkspaceId(db);
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
      externalId: "7001",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  fake.setAppPermissions(WRITE);
  fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  fake.setInstallationPermissions(4242, options.accepted ?? WRITE);
  fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);

  // The models.dev catalog has deepseek with one model, and the workspace has saved a key for it (its own key).
  await createModelsDevRepository(db).apply({
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        url: {
          state: "trusted",
          trustedUrl: "https://api.deepseek.example",
          pendingUrl: null,
          problem: null,
        },
        urlChangedAt: null,
        firstSeenAt: T,
        unlistedAt: null,
        updatedAt: T,
      },
    ],
    models: [
      {
        providerId: "deepseek",
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        family: null,
        limit: { context: 128_000, output: 8_000 },
        reasoning: true,
        temperature: true,
        attachment: false,
        modalities: { input: ["text"], output: ["text"] },
        status: null,
        cost: { input: "0.5", output: "1.5" },
        lastUpdated: null,
        interleaved: null,
        firstSeenAt: T,
        unlistedAt: null,
        updatedAt: T,
      },
    ],
  } as never);

  // The registry reads the environment on first use, so every test loads the routes anew.
  vi.resetModules();
  const { getWorkspaceLlm } = await import("../../src/llm/shared.ts");
  await getWorkspaceLlm()
    .keyServiceFor(workspaceId)
    .save({ provider: "deepseek", apiKey: DEEPSEEK_KEY }, null);
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, {
      workspaceId,
      role: options.role ?? "member",
      githubLogin: "octocat",
    }),
  );
  const repositoriesRoute =
    await import("../../src/app/api/w/[workspace]/implementer/repositories/route.ts");
  const branchesRoute =
    await import("../../src/app/api/w/[workspace]/implementer/repositories/[repositoryId]/branches/route.ts");
  const modelsRoute =
    await import("../../src/app/api/w/[workspace]/implementer/models/route.ts");
  const tasksRoute =
    await import("../../src/app/api/w/[workspace]/implementer/tasks/route.ts");

  const base = (workspace: string) =>
    `https://app.test/api/w/${workspace}/implementer`;
  const repositoriesGet = (workspace = "default") =>
    repositoriesRoute.GET(new Request(`${base(workspace)}/repositories`), {
      params: Promise.resolve({ workspace }),
    } as Parameters<typeof repositoriesRoute.GET>[1]);
  const branchesGet = (repositoryId: string, workspace = "default") =>
    branchesRoute.GET(
      new Request(`${base(workspace)}/repositories/${repositoryId}/branches`),
      {
        params: Promise.resolve({ workspace, repositoryId }),
      } as Parameters<typeof branchesRoute.GET>[1],
    );
  const modelsGet = (workspace = "default") =>
    modelsRoute.GET(new Request(`${base(workspace)}/models`), {
      params: Promise.resolve({ workspace }),
    } as Parameters<typeof modelsRoute.GET>[1]);
  const tasksPost = (body: unknown, workspace = "default") =>
    tasksRoute.POST(
      new Request(`${base(workspace)}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ workspace }) } as Parameters<
        typeof tasksRoute.POST
      >[1],
    );
  const body = (overrides: Record<string, unknown> = {}) => ({
    repositoryId: repository.id,
    baseBranch: "main",
    branch: "implementer/abc123",
    instruction: "Add a health endpoint.",
    model: { provider: "deepseek", model: "deepseek-v4-pro" },
    clientRequestId: "request-1",
    ...overrides,
  });
  const jobs = () => db.selectFrom("jobs").selectAll().execute();
  return {
    db,
    fake,
    repository,
    repositoriesRoute,
    branchesRoute,
    modelsRoute,
    tasksRoute,
    repositoriesGet,
    branchesGet,
    modelsGet,
    tasksPost,
    body,
    jobs,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

describe("the Implementer route files", () => {
  // #755-T01
  it("list the repositories of the workspace in the address", async () => {
    const { repositoriesGet, repository } = await startRoutes();

    const response = await repositoriesGet();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      repositories: [
        {
          id: repository.id,
          fullName: "acme/widgets",
          writeGranted: true,
          unwritable: null,
        },
      ],
    });
  });

  // #755-T02
  it("list the branches of a repository, from GitHub", async () => {
    const { branchesGet, repository } = await startRoutes();

    const response = await branchesGet(repository.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      defaultBranch: "main",
      branches: ["main"],
      truncated: false,
    });
  });

  // #755-T07
  it("list the models of the workspace's own key: the provider with a saved key and the models the catalog lists", async () => {
    const { modelsGet } = await startRoutes();

    const response = await modelsGet();

    expect(response.status).toBe(200);
    const answer = (await response.json()) as {
      keyMode: string;
      providers: { id: string; label: string; models: { id: string }[] }[];
    };
    expect(answer.keyMode).toBe("own");
    expect(answer.providers).toMatchObject([
      {
        id: "deepseek",
        label: "DeepSeek",
        models: [{ id: "deepseek-v4-pro" }],
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain(DEEPSEEK_KEY);
  });

  // #755-T03
  it("start a task in the real database for the signed in person, and repeat it as the same task", async () => {
    const { tasksPost, body, jobs, repository } = await startRoutes();

    const response = await tasksPost(body());

    expect(response.status).toBe(201);
    const first = (await response.json()) as { runId: string };
    expect(await jobs()).toMatchObject([
      {
        id: first.runId,
        repository_id: repository.id,
        review_kind: "implementer",
        trigger_kind: "manual",
        actor_login: "octocat",
        status: "queued",
      },
    ]);
    const again = await tasksPost(body());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ runId: first.runId });
    expect(await jobs()).toHaveLength(1);
  });

  // #755-T07
  it("refuse a model the claim would refuse (no key for the provider, a model the catalog does not list, an entry id on the own key), and start nothing", async () => {
    const { tasksPost, body, jobs } = await startRoutes();

    for (const [model, reason] of [
      [{ provider: "mistral", model: "mistral-large" }, "no_key"],
      [{ provider: "deepseek", model: "nope" }, "model_not_in_catalog"],
      [
        { provider: "anthropic", model: "claude-sonnet-5-5" },
        "provider_unsupported",
      ],
      [{ entryId: "entry-1" }, "wrong_key_mode"],
    ] as const) {
      const response = await tasksPost(body({ model }));
      expect(response.status, JSON.stringify(model)).toBe(422);
      expect(await response.json()).toEqual({
        error: "IMPLEMENTER_MODEL_NOT_ALLOWED",
        reason,
      });
    }
    expect(await jobs()).toEqual([]);
  });

  // #755-T08
  it("refuse a task for an installation that has not accepted contents write", async () => {
    const { tasksPost, body, jobs } = await startRoutes({
      accepted: { ...WRITE, contents: "read" } as never,
    });

    const response = await tasksPost(body());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_WRITE_NOT_GRANTED",
    });
    expect(await jobs()).toEqual([]);
  });

  // #755-T09
  it("let every role of the workspace through, a Member included", async () => {
    for (const role of ["member", "admin", "owner"] as const) {
      const { repositoriesGet, modelsGet } = await startRoutes({ role });
      expect((await repositoriesGet()).status, role).toBe(200);
      expect((await modelsGet()).status, role).toBe(200);
      await closeDatabase();
      await Promise.all(fakes.splice(0).map((fake) => fake.close()));
    }
  });

  // #755-T09, #101-WM-06, #101-WM-07
  it("answer a person who does not belong to the workspace like a workspace that does not exist, and start nothing", async () => {
    const {
      repositoriesGet,
      branchesGet,
      modelsGet,
      tasksPost,
      body,
      jobs,
      db,
      repository,
    } = await startRoutes();
    session.currentLookup.mockResolvedValue(
      await signedInMember(db, { id: "outsider" }),
    );

    for (const workspace of ["default", "no-such-workspace"]) {
      for (const response of [
        await repositoriesGet(workspace),
        await branchesGet(repository.id, workspace),
        await modelsGet(workspace),
        await tasksPost(body(), workspace),
      ]) {
        expect(response.status, workspace).toBe(404);
        expect(await response.json(), workspace).toEqual({
          error: "not_found",
        });
      }
    }
    expect(await jobs()).toEqual([]);
  });

  // #755-T09
  it("ask for the session before they read anything, and answer a visitor with 401", async () => {
    const {
      repositoriesGet,
      branchesGet,
      modelsGet,
      tasksPost,
      body,
      jobs,
      repository,
    } = await startRoutes();
    session.currentLookup.mockResolvedValue({ kind: "none" });

    for (const response of [
      await repositoriesGet(),
      await branchesGet(repository.id),
      await modelsGet(),
      await tasksPost(body()),
    ])
      expect(response.status).toBe(401);
    expect(await jobs()).toEqual([]);
  });

  // #755-T10
  it.each(["factoryToday", "codeReviewCom"] as const)(
    "answer the 404 of a path that does not exist in a deployment without the capability (%s), before the session or the database is asked, and start nothing",
    async (deployment) => {
      const {
        repositoriesGet,
        branchesGet,
        modelsGet,
        tasksPost,
        body,
        jobs,
        repository,
      } = await startRoutes({ deployment });
      // Not even a visitor without a session gets another answer than a path that does not exist has.
      session.currentLookup.mockClear();
      session.currentLookup.mockResolvedValue({ kind: "none" });

      for (const call of [
        () => repositoriesGet(),
        () => branchesGet(repository.id),
        () => modelsGet(),
        () => tasksPost(body()),
      ])
        await expect(call()).rejects.toMatchObject({
          digest: "NEXT_HTTP_ERROR_FALLBACK;404",
        });
      expect(session.currentLookup).not.toHaveBeenCalled();
      expect(await jobs()).toEqual([]);
    },
  );

  it("export only the method each route serves", async () => {
    const { repositoriesRoute, branchesRoute, modelsRoute, tasksRoute } =
      await startRoutes();

    expect(Object.keys(repositoriesRoute).sort()).toEqual(["GET"]);
    expect(Object.keys(branchesRoute).sort()).toEqual(["GET"]);
    expect(Object.keys(modelsRoute).sort()).toEqual(["GET"]);
    expect(Object.keys(tasksRoute).sort()).toEqual(["POST"]);
  });
});
