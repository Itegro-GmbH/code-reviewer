// SPDX-License-Identifier: LicenseRef-Proprietary

// The repository of the OAuth connections of MCP servers (#1051) over a real Postgres: what the start and the callback store, the compare and
// swap of the token pair, the row lock of a refresh, the revision a connection is saved for, and that a server's edit takes the tokens along.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import {
  createMcpOAuthRepository,
  type McpOAuthDiscovery,
} from "./mcp-oauth-repository.ts";
import { createMcpServersRepository } from "./mcp-servers-repository.ts";

const SEALED = { ciphertext: "c", nonce: "n", keyVersion: 1 };
const DISCOVERY: McpOAuthDiscovery = {
  resource: "https://mcp.example.com/mcp",
  issuer: "https://as.example.com",
  authorizationEndpoint: "https://as.example.com/authorize",
  tokenEndpoint: "https://as.example.com/token",
  registrationEndpoint: "https://as.example.com/register",
  scopes: ["a"],
  issParameter: true,
  authMethods: ["none"],
};

async function setup() {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const servers = createMcpServersRepository(db, workspaceId);
  const oauth = createMcpOAuthRepository(db, workspaceId);
  const created = await servers.create(
    {
      id: "s1",
      name: "Notion",
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
      authKind: "oauth",
      headerNames: [],
      sealed: null,
      createdBy: null,
    },
    50,
  );
  if (!created.ok) throw new Error("seeding failed");
  return { db, workspaceId, servers, oauth };
}

const dynamicClient = {
  source: "dynamic" as const,
  clientId: "client-1",
  authMethod: "none" as const,
  sealedSecret: null,
  registeredIssuer: "https://as.example.com",
  registeredRedirectUri: "https://factory.example.test/api/mcp/oauth/callback",
};
const connection = (
  over: Partial<
    Parameters<ReturnType<typeof createMcpOAuthRepository>["saveConnection"]>[2]
  > = {},
) => ({
  sealedTokens: SEALED,
  accessExpiresAt: new Date("2026-11-17T11:00:00.000Z"),
  scopes: ["a"],
  connectedBy: null,
  ...over,
});

describe("the OAuth connections of MCP servers", () => {
  // #1051-T01
  it("keeps what discovery found and the client for the start, then the sealed pair for the callback", async () => {
    const { oauth } = await setup();
    expect(await oauth.get("s1")).toBeUndefined();

    expect(
      await oauth.saveStart("s1", 1, {
        discovery: DISCOVERY,
        client: dynamicClient,
      }),
    ).toBe(true);
    expect(await oauth.get("s1")).toMatchObject({
      status: "unconnected",
      discovery: DISCOVERY,
      clientSource: "dynamic",
      clientId: "client-1",
      clientAuthMethod: "none",
      hasClientSecret: false,
      accessExpiresAt: null,
    });
    expect(await oauth.saveConnection("s1", 1, connection())).toBe(true);

    const read = await oauth.readSecrets("s1");
    expect(read).toMatchObject({
      tokens: SEALED,
      tokenVersion: 2,
      oauth: {
        status: "connected",
        scopes: ["a"],
        accessExpiresAt: "2026-11-17T11:00:00.000Z",
      },
    });
    // A start again keeps the client and the pair when no new client is given.
    expect(
      await oauth.saveStart("s1", 1, {
        discovery: { ...DISCOVERY, scopes: ["b"] },
      }),
    ).toBe(true);
    expect(await oauth.readSecrets("s1")).toMatchObject({
      tokens: SEALED,
      oauth: {
        status: "connected",
        clientId: "client-1",
        discovery: { scopes: ["b"] },
      },
    });
  });

  // #1051-T03
  it("stores nothing for a server that was edited since the flow began, or that no longer uses OAuth", async () => {
    const { oauth, servers } = await setup();
    await oauth.saveStart("s1", 1, {
      discovery: DISCOVERY,
      client: dynamicClient,
    });
    const edited = await servers.update("s1", 1, {
      name: "Notion",
      transport: "streamable-http",
      url: "https://mcp.example.com/other",
      authKind: "oauth",
      headerNames: [],
      sealed: null,
      oauth: { kind: "drop" },
    });
    expect(edited.ok).toBe(true);

    expect(await oauth.saveConnection("s1", 1, connection())).toBe(false);
    expect(await oauth.saveStart("s1", 1, { discovery: DISCOVERY })).toBe(
      false,
    );
    // The edit took the connection along.
    expect(await oauth.get("s1")).toBeUndefined();
    const none = await servers.update("s1", 2, {
      name: "Notion",
      transport: "streamable-http",
      url: "https://mcp.example.com/other",
      authKind: "none",
      headerNames: [],
      sealed: null,
    });
    expect(none.ok).toBe(true);
    expect(await oauth.saveConnection("s1", 3, connection())).toBe(false);
  });

  // #1051-T02
  it("replaces the pair only for the version that was read, and marks a connection broken for that version only", async () => {
    const { oauth } = await setup();
    await oauth.saveStart("s1", 1, {
      discovery: DISCOVERY,
      client: dynamicClient,
    });
    await oauth.saveConnection("s1", 1, connection());
    const version = (await oauth.readSecrets("s1"))?.tokenVersion ?? 0;
    const renewed = { ciphertext: "c2", nonce: "n2", keyVersion: 1 };
    const later = new Date("2026-11-17T12:00:00.000Z");

    const results = await oauth.withLockedTokens(
      "s1",
      async (locked, writes) => ({
        sawVersion: locked?.tokenVersion,
        stale: await writes.replaceTokens(version - 1, renewed, later, null),
        fresh: await writes.replaceTokens(version, renewed, later, ["x", "y"]),
        brokenStale: await writes.markBroken(
          version,
          "mcp_oauth_refresh_refused",
        ),
        broken: await writes.markBroken(
          version + 1,
          "mcp_oauth_refresh_refused",
        ),
      }),
    );

    expect(results).toEqual({
      sawVersion: version,
      stale: false,
      fresh: true,
      brokenStale: false,
      broken: true,
    });
    expect(await oauth.readSecrets("s1")).toMatchObject({
      tokens: renewed,
      oauth: {
        status: "broken",
        errorCode: "mcp_oauth_refresh_refused",
        scopes: ["x", "y"],
      },
    });
    // Connecting again mends it.
    await oauth.saveConnection("s1", 1, connection());
    expect((await oauth.get("s1"))?.status).toBe("connected");
    expect((await oauth.get("s1"))?.errorCode).toBeNull();
  });

  // #1051-T02
  it("serializes two refreshes of one server: the second waits for the first", async () => {
    const { oauth } = await setup();
    await oauth.saveStart("s1", 1, {
      discovery: DISCOVERY,
      client: dynamicClient,
    });
    await oauth.saveConnection("s1", 1, connection());
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = oauth.withLockedTokens("s1", async () => {
      order.push("first in");
      await gate;
      order.push("first out");
    });
    // Let the first take its lock.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = oauth.withLockedTokens("s1", async () => {
      order.push("second in");
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual(["first in"]);
    release();
    await Promise.all([first, second]);

    expect(order).toEqual(["first in", "first out", "second in"]);
  });

  it("holds the client an Owner entered with its sealed secret, and replaces the whole connection when it changes", async () => {
    const { oauth, servers, workspaceId, db } = await setup();
    await oauth.saveStart("s1", 1, {
      discovery: DISCOVERY,
      client: dynamicClient,
    });
    await oauth.saveConnection("s1", 1, connection());

    const changed = await servers.update("s1", 1, {
      name: "Notion",
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
      authKind: "oauth",
      headerNames: [],
      sealed: null,
      oauth: {
        kind: "replace-manual",
        client: {
          source: "manual",
          clientId: "entered",
          authMethod: "client_secret_basic",
          sealedSecret: { ciphertext: "cs", nonce: "ns", keyVersion: 1 },
        },
      },
    });

    expect(changed).toMatchObject({
      ok: true,
      server: { testStatus: "untested" },
    });
    expect(await oauth.readSecrets("s1")).toMatchObject({
      clientSecret: { ciphertext: "cs", nonce: "ns", keyVersion: 1 },
      tokens: null,
      oauth: {
        status: "unconnected",
        clientSource: "manual",
        clientId: "entered",
        hasClientSecret: true,
        discovery: null,
      },
    });
    // The plain list is the workspace's; another workspace's repository does not see it.
    const other = createMcpOAuthRepository(db, await addWorkspace(db, "other"));
    expect(await other.list()).toEqual([]);
    expect(await createMcpOAuthRepository(db, workspaceId).list()).toHaveLength(
      1,
    );
  });

  it("goes with its server when the server is removed", async () => {
    const { oauth, servers } = await setup();
    await oauth.saveStart("s1", 1, {
      discovery: DISCOVERY,
      client: dynamicClient,
    });

    expect(await servers.removeUnlessUsed("s1")).toEqual({ removed: true });

    expect(await oauth.list()).toEqual([]);
  });

  it("keeps the table's own rules: a state that agrees with the tokens, the client and the error", async () => {
    const { db, workspaceId } = await setup();
    const insert = (values: Record<string, unknown>) =>
      db
        .insertInto("mcp_oauth_connections")
        .values({
          server_id: "s1",
          workspace_id: workspaceId,
          created_at: "t",
          updated_at: "t",
          ...values,
        } as never)
        .execute();

    await expect(insert({ status: "connected" })).rejects.toThrow(
      /mcp_oauth_connections_tokens_check/,
    );
    await expect(
      insert({
        status: "broken",
        error_code: null,
        tokens_ciphertext: "c",
        tokens_nonce: "n",
        tokens_key_version: 1,
        access_expires_at: "t",
      }),
    ).rejects.toThrow(/mcp_oauth_connections_error_check/);
    await expect(insert({ client_id: "x" })).rejects.toThrow(
      /mcp_oauth_connections_client_check/,
    );
    await expect(insert({ status: "odd" })).rejects.toThrow(
      /mcp_oauth_connections_status_check/,
    );
    await insert({});
  });
});
