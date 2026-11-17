// SPDX-License-Identifier: LicenseRef-Proprietary

// The OAuth connection of MCP servers assembled for integration tests (src/mcp/, #1051): a real database, a fake authorization server and a fake
// OAuth-protected MCP server on two loopback ports (so the authorization server is NOT on the MCP server's origin), the real registry service,
// token handling, OAuth service and route handlers, and a clock the test moves. `walk` does what a person does: presses "Connect", goes to the
// consent page, and comes back to the callback.
import {
  startOAuthFake,
  type OAuthFake,
  type OAuthFakeOptions,
} from "../../../fakes/mcp/oauth.ts";
import {
  startMcpFake,
  type FakeMcpOptions,
  type McpFake,
} from "../../../fakes/mcp/server.ts";
import { createMcpOAuthRepository } from "../db/repositories/mcp-oauth-repository.ts";
import { createMcpServersRepository } from "../db/repositories/mcp-servers-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { WorkspaceRole } from "../db/workspace-roles.ts";
import { createGuardedFetch } from "../dispatch/guarded-fetch.ts";
import { createMcpRouteHandlers } from "../mcp/http.ts";
import {
  createMcpOAuthRouteHandlers,
  type McpOAuthRouteDependencies,
  type McpOAuthRouteHandlers,
} from "../mcp/oauth/http.ts";
import {
  createMcpOAuthService,
  type McpOAuthActor,
} from "../mcp/oauth/service.ts";
import { createMcpOAuthTokens } from "../mcp/oauth/tokens.ts";
import { createMcpService } from "../mcp/service.ts";
import { createSignedStates } from "../signed-state/state.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import { sessionUser } from "./session-lookup.ts";
import { cleanUpAfterTest, createTestDatabase } from "./test-database.ts";
import { insertUser } from "./users.ts";

export const MCP_OAUTH_TEST_PUBLIC_URL = "https://factory.example.test";
export const MCP_OAUTH_TEST_SECRET = "a-master-key-of-the-mcp-oauth-tests-32!";

export type McpOAuthHarnessOptions = {
  authorizationServer?: OAuthFakeOptions;
  mcpServer?: Omit<FakeMcpOptions, "oauth">;
  /** The `scopes` the MCP server's metadata lists. */
  scopes?: string[];
};

export async function createMcpOAuthHarness(
  options: McpOAuthHarnessOptions = {},
) {
  const { db } = await createTestDatabase();
  const as: OAuthFake = await startOAuthFake(options.authorizationServer);
  cleanUpAfterTest(() => as.close());
  const mcp: McpFake = await startMcpFake({
    ...options.mcpServer,
    oauth: {
      authorizationServer: as.issuer,
      validate: (token) => as.isValidAccessToken(token),
      ...(options.scopes === undefined ? {} : { scopes: options.scopes }),
    },
  });
  cleanUpAfterTest(() => mcp.close());
  const clock = { time: Date.parse("2026-11-17T10:00:00.000Z") };
  const now = () => new Date(clock.time);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const fetchImpl = createGuardedFetch({ allowLoopback: true });
  const http = { fetch: fetchImpl, allowTestEndpoints: true, deadlineMs: 5000 };
  const workspaces = createWorkspacesRepository(db, now);
  const rateLimits = createRateLimitsRepository(db);

  const oauth = createMcpOAuthService({
    db,
    signedStates: createSignedStates({
      db,
      appSecret: MCP_OAUTH_TEST_SECRET,
      now,
    }),
    rateLimits,
    http,
    publicUrl: MCP_OAUTH_TEST_PUBLIC_URL,
    appSecret: MCP_OAUTH_TEST_SECRET,
    clientName: "Test product",
    now,
    log,
  });

  /** The registry of a workspace. */
  const registry = (workspaceId: string) =>
    createMcpService({
      workspaceId,
      repository: createMcpServersRepository(db, workspaceId, now),
      oauth: createMcpOAuthRepository(db, workspaceId, now),
      rateLimits,
      appSecret: MCP_OAUTH_TEST_SECRET,
      fetch: fetchImpl,
      allowTestEndpoints: true,
      testLimits: { deadlineMs: 5000 },
      now,
      log,
    });
  const registryHandlers = createMcpRouteHandlers({ serviceFor: registry });
  /** The token handling of a workspace (what the test connection and, later, the proxy use). */
  const tokensFor = (workspaceId: string) =>
    createMcpOAuthTokens({
      repository: createMcpOAuthRepository(db, workspaceId, now),
      appSecret: MCP_OAUTH_TEST_SECRET,
      http,
      now,
      log,
    });

  async function workspace(slug: string) {
    return workspaces.create({
      name: `Workspace ${slug}`,
      slug,
      createdBy: null,
    });
  }

  /** A signed in person: the account (once) and, if asked, a membership. */
  async function person(
    id: string,
    membership?: { workspaceId: string; role: WorkspaceRole },
    session = `session-${id}`,
  ): Promise<McpOAuthActor> {
    const exists = await db
      .selectFrom("users")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (exists === undefined) await insertUser(db, { id, emailVerified: true });
    if (membership !== undefined)
      await workspaces.addMember(membership.workspaceId, id, membership.role);
    return { id, sessionId: session };
  }

  function accessOf(
    actor: McpOAuthActor,
    value: Awaited<ReturnType<typeof workspace>>,
    role: WorkspaceRole,
  ): WorkspaceAccess {
    return { user: sessionUser(actor.id), workspace: value, role };
  }

  function handlers(
    actor: McpOAuthActor | null,
    overrides: Partial<McpOAuthRouteDependencies> = {},
  ): McpOAuthRouteHandlers {
    return createMcpOAuthRouteHandlers({
      service: oauth,
      sessionId: async () => actor?.sessionId ?? null,
      session: async () =>
        actor === null
          ? null
          : { userId: actor.id, sessionId: actor.sessionId },
      workspaceSlug: async (id) => (await workspaces.get(id))?.slug ?? null,
      ...overrides,
    });
  }

  /** A server of the kind `oauth` for the MCP fake (`which` picks the transport's address). */
  async function addServer(
    value: Awaited<ReturnType<typeof workspace>>,
    actor: McpOAuthActor,
    over: Record<string, unknown> = {},
    auth: Record<string, unknown> = {},
  ) {
    const created = await registry(value.id).create(actor, {
      name: "Fake OAuth",
      transport: "streamable-http",
      url: mcp.url,
      auth: { kind: "oauth", ...auth },
      ...over,
    });
    if (!created.ok)
      throw new Error(`the server was refused: ${created.error}`);
    return created.value;
  }

  /**
   * What a person does: "Connect", the consent page, back to the callback. `tamper` changes the query of the callback; the answer is the page
   * the browser lands on.
   */
  async function walk(
    actor: McpOAuthActor,
    value: Awaited<ReturnType<typeof workspace>>,
    role: WorkspaceRole,
    serverId: string,
    step: {
      tamper?: (query: URLSearchParams) => void;
      /** The person who comes back to the callback, when it is not the one who started. */
      returningAs?: McpOAuthActor;
      /** Runs between the consent page and the callback (an edit, a clock that moves). */
      between?: () => Promise<void> | void;
    } = {},
  ): Promise<{ landing: string; consent: string }> {
    const start = await handlers(actor).connect(
      new Request("https://factory.example.test/api", { method: "POST" }),
      accessOf(actor, value, role),
      serverId,
    );
    const body = (await start.json()) as { url?: string; error?: string };
    if (body.url === undefined)
      throw new Error(`Connect was refused: ${body.error ?? start.status}`);
    const consent = await fetch(body.url, { redirect: "manual" });
    const location = consent.headers.get("location");
    if (location === null)
      throw new Error(`The consent page did not redirect (${consent.status}).`);
    const back = new URL(location);
    step.tamper?.(back.searchParams);
    await step.between?.();
    const landed = await handlers(step.returningAs ?? actor).callback(
      new Request(back.toString()),
    );
    return { landing: landed.headers.get("location") ?? "", consent: body.url };
  }

  return {
    db,
    as,
    mcp,
    clock,
    now,
    logs,
    oauth,
    registry,
    registryHandlers,
    tokensFor,
    workspaces,
    workspace,
    person,
    accessOf,
    handlers,
    addServer,
    walk,
  };
}
