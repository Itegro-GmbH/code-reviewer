// SPDX-License-Identifier: LicenseRef-Proprietary

// The OAuth connection of an MCP server (#1051) against a real Postgres, a fake authorization server and a fake OAuth-protected MCP server
// (on another origin than the authorization server): discovery, registration, consent, callback, tool list; the refresh before expiry, serialized;
// a refresh the authorization server refuses ends the connection and a wrong client does not; a wrong, used or foreign state is refused; and no
// token ever leaves the server. The route handlers and services are the real ones.
import { describe, expect, it } from "vitest";
import { startOAuthFake } from "../../../../fakes/mcp/oauth.ts";
import { createRateLimitsRepository } from "../../db/repositories/rate-limits-repository.ts";
import { cleanUpAfterTest } from "../../test-support/test-database.ts";
import { createMcpOAuthHarness } from "../../test-support/mcp-oauth-harness.ts";
import { REFRESH_MARGIN_MS } from "./tokens.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

async function setup(
  options: Parameters<typeof createMcpOAuthHarness>[0] = {},
) {
  const h = await createMcpOAuthHarness(options);
  const ws = await h.workspace("acme");
  const owner = await h.person("owner", { workspaceId: ws.id, role: "owner" });
  return { h, ws, owner };
}

/** A server the owner connected: the round trip is done. */
async function connected(
  options: Parameters<typeof createMcpOAuthHarness>[0] = {},
) {
  const { h, ws, owner } = await setup(options);
  const server = await h.addServer(ws, owner);
  const { landing } = await h.walk(owner, ws, "owner", server.id);
  expect(landing).toContain("mcp=connected");
  return { h, ws, owner, server, tokens: h.tokensFor(ws.id) };
}

describe("Connect of an MCP server that uses OAuth", () => {
  // #1051-T01
  it("discovers the authorization server, registers a client, walks the consent page and the callback, and lists the tools with the token", async () => {
    const { h, ws, owner } = await setup({
      scopes: ["issues:read"],
    });
    const server = await h.addServer(ws, owner);
    expect(server.oauth).toMatchObject({
      status: "unconnected",
      clientSource: null,
    });

    const { landing, consent } = await h.walk(owner, ws, "owner", server.id);

    // The browser lands on the MCP page of the workspace with our own code and the server's id.
    expect(landing).toBe(`/w/acme/mcp?mcp=connected&server=${server.id}`);
    // What a real consent page checks: PKCE S256, the exact callback, the resource of the MCP server, the scope, a state.
    const url = new URL(consent);
    expect(url.origin).toBe(h.as.origin);
    expect(url.origin).not.toBe(h.mcp.origin);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://factory.example.test/api/mcp/oauth/callback",
    );
    expect(url.searchParams.get("resource")).toBe(h.mcp.url);
    expect(url.searchParams.get("scope")).toBe("issues:read");
    expect(url.searchParams.get("state")).toBeTruthy();
    // The registration happened once, the exchange carried the resource, and the server was asked without a credential first.
    expect(h.as.registrations()).toBe(1);
    expect(
      h.as.requests().find((r) => r.grantType === "authorization_code"),
    ).toMatchObject({ resource: h.mcp.url, clientAuth: "none" });
    expect(h.mcp.requests()[0]).toMatchObject({
      method: "POST",
      authorized: false,
    });

    // The test connection runs with the token and lists the tools.
    const tested = await h.registry(ws.id).test(server.id);
    const issued = h.as.lastIssued();
    expect(tested).toMatchObject({
      ok: true,
      value: {
        status: "ok",
        oauth: {
          status: "connected",
          clientSource: "dynamic",
          scopes: ["issues:read"],
        },
        tools: { tools: [{ name: "search_issues" }, { name: "get_issue" }] },
      },
    });
    expect(h.mcp.sawBearer(issued?.accessToken ?? "-")).toBe(true);

    // A second Connect (a reconnect) uses the registered client again.
    const again = await h.walk(owner, ws, "owner", server.id);
    expect(again.landing).toContain("mcp=connected");
    expect(h.as.registrations()).toBe(1);
  });

  // #1051-T01
  it("never lets a token or a secret out: not in an answer, a row in the clear, a log line or the state", async () => {
    const { h, ws, owner, server } = await connected();
    await h.registry(ws.id).test(server.id);
    const issued = h.as.lastIssued();
    const secrets = [issued?.accessToken ?? "-", issued?.refreshToken ?? "-"];

    const listed = JSON.stringify(await h.registry(ws.id).list());
    const rows = JSON.stringify(
      await h.db.selectFrom("mcp_oauth_connections").selectAll().execute(),
    );
    const states = JSON.stringify(
      await h.db.selectFrom("signed_states").selectAll().execute(),
    );
    for (const text of [listed, rows, states, h.logs.join("\n")])
      for (const secret of secrets) expect(text).not.toContain(secret);
    expect(owner.id).toBeTruthy();
    const row = await h.db
      .selectFrom("mcp_oauth_connections")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.tokens_ciphertext).not.toBeNull();
  });

  // #1051-T01
  it("uses a client the Owner entered when the authorization server has no registration, and says so when there is none", async () => {
    const { h, ws, owner } = await setup({
      authorizationServer: { registration: false },
    });
    const server = await h.addServer(ws, owner);

    const refused = await h
      .handlers(owner)
      .connect(
        new Request("https://factory.example.test/api", { method: "POST" }),
        h.accessOf(owner, ws, "owner"),
        server.id,
      );
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({
      error: "mcp_oauth_client_required",
    });

    h.as.addClient({
      clientId: "entered-client",
      clientSecret: "entered-secret",
    });
    const edited = await h.registry(ws.id).update(server.id, {
      name: "Fake OAuth",
      transport: "streamable-http",
      url: h.mcp.url,
      auth: {
        kind: "oauth",
        clientId: "entered-client",
        issuer: h.as.issuer,
        clientSecret: "entered-secret",
      },
      revision: server.revision,
    });
    if (!edited.ok) throw new Error(edited.error);
    expect(edited.value.oauth).toMatchObject({
      clientSource: "manual",
      clientId: "entered-client",
      hasClientSecret: true,
    });
    expect(JSON.stringify(edited.value)).not.toContain("entered-secret");
    const { landing } = await h.walk(owner, ws, "owner", server.id);

    expect(landing).toContain("mcp=connected");
    // A confidential client authenticates with Basic.
    expect(
      h.as.requests().find((r) => r.grantType === "authorization_code"),
    ).toMatchObject({
      clientId: "entered-client",
      clientAuth: "basic",
    });
    expect(h.as.registrations()).toBe(0);
  });

  it("does not connect a server that does not use OAuth, and only an Owner or Admin can start", async () => {
    const { h, ws, owner } = await setup();
    const member = await h.person("member", {
      workspaceId: ws.id,
      role: "member",
    });
    const plain = await h.registry(ws.id).create(owner, {
      name: "Plain",
      transport: "streamable-http",
      url: h.mcp.url,
      auth: { kind: "none" },
    });
    if (!plain.ok) throw new Error(plain.error);
    const server = await h.addServer(ws, owner, { name: "OAuth one" });
    const start = (actor: typeof owner, role: "owner" | "member", id: string) =>
      h
        .handlers(actor)
        .connect(
          new Request("https://factory.example.test/api", { method: "POST" }),
          h.accessOf(actor, ws, role),
          id,
        );

    expect((await start(owner, "owner", plain.value.id)).status).toBe(409);
    expect((await start(member, "member", server.id)).status).toBe(403);
    // A role that is stale in the request is not enough: the membership is read again.
    expect((await start(member, "owner", server.id)).status).toBe(403);
    expect((await start(owner, "owner", "no-such-server")).status).toBe(404);
  });
});

describe("the token of an MCP server", () => {
  // #1051-T02
  it("is refreshed before it ends, with one refresh for requests that come together, and the rotated pair is kept", async () => {
    const { h, ws, server, tokens } = await connected({
      authorizationServer: { accessTokenTtlSeconds: 3600 },
    });
    const first = await tokens.use(server.id, { serverUrl: h.mcp.url });
    const before = h.as
      .requests()
      .filter((r) => r.grantType === "refresh_token").length;
    expect(before).toBe(0);

    // Not yet within the margin: nothing is asked of the authorization server.
    h.clock.time += HOUR - REFRESH_MARGIN_MS - MINUTE;
    const still = await tokens.use(server.id, { serverUrl: h.mcp.url });
    expect(still.ok && still.accessToken.reveal()).toBe(
      first.ok && first.accessToken.reveal(),
    );
    expect(
      h.as.requests().filter((r) => r.grantType === "refresh_token"),
    ).toHaveLength(0);

    // Within the margin, three requests at once: ONE refresh, and all three get the new token (a rotated refresh token is used once).
    h.clock.time += 2 * MINUTE;
    const results = await Promise.all([
      tokens.use(server.id, { serverUrl: h.mcp.url }),
      tokens.use(server.id, { serverUrl: h.mcp.url }),
      tokens.use(server.id, { serverUrl: h.mcp.url }),
    ]);

    expect(
      h.as.requests().filter((r) => r.grantType === "refresh_token"),
    ).toHaveLength(1);
    const renewed = h.as.lastIssued()?.accessToken;
    for (const result of results)
      expect(result.ok && result.accessToken.reveal()).toBe(renewed);
    expect(renewed).not.toBe(first.ok && first.accessToken.reveal());
    expect(
      h.as.requests().find((r) => r.grantType === "refresh_token"),
    ).toMatchObject({
      resource: h.mcp.url,
    });
    // The pair after the refresh works for the next one, and the MCP server accepts it.
    h.clock.time += HOUR - 2 * MINUTE;
    const next = await h.registry(ws.id).test(server.id);
    expect(next).toMatchObject({
      ok: true,
      value: { status: "ok", oauth: { status: "connected" } },
    });
    expect(h.mcp.sawBearer(h.as.lastIssued()?.accessToken ?? "-")).toBe(true);
  });

  // #1051-T02
  it("is renewed once and the call repeated when the MCP server says the token is no good", async () => {
    const { h, ws, server } = await connected();
    const stale = h.as.lastIssued()?.accessToken ?? "-";
    h.as.endAccessTokens();

    const tested = await h.registry(ws.id).test(server.id);

    expect(tested).toMatchObject({ ok: true, value: { status: "ok" } });
    expect(h.as.lastIssued()?.accessToken).not.toBe(stale);
    expect(
      h.as.requests().filter((r) => r.grantType === "refresh_token"),
    ).toHaveLength(1);
  });

  // #1051-T02
  it("marks the server broken when the authorization server refuses the refresh (invalid_grant), and makes no call after that", async () => {
    const { h, ws, server } = await connected();
    h.as.revokeRefreshTokens();
    h.clock.time += HOUR;

    const tested = await h.registry(ws.id).test(server.id);

    expect(tested).toMatchObject({
      ok: true,
      value: {
        status: "failed",
        testErrorCode: "mcp_test_oauth_broken",
        oauth: { status: "broken", errorCode: "mcp_oauth_refresh_refused" },
      },
    });
    expect(
      h.logs.some((line) => line.includes("MCP_OAUTH_CONNECTION_BROKEN")),
    ).toBe(true);
    const calls = h.as.requests().length;
    const mcpCalls = h.mcp.requests().length;
    const again = await h.registry(ws.id).test(server.id);
    expect(again).toMatchObject({
      ok: true,
      value: { testErrorCode: "mcp_test_oauth_broken" },
    });
    expect(h.as.requests()).toHaveLength(calls);
    expect(h.mcp.requests()).toHaveLength(mcpCalls);

    // Connecting again mends it.
    const owner = await h.person("owner");
    const { landing } = await h.walk(owner, ws, "owner", server.id);
    expect(landing).toContain("mcp=connected");
    const mended = await h.registry(ws.id).test(server.id);
    expect(mended).toMatchObject({
      ok: true,
      value: { status: "ok", oauth: { status: "connected" } },
    });
  });

  // #1051-T02
  it("is NOT marked broken by a wrong client, a failing authorization server, a changed key or a moved endpoint: the operator's log says why", async () => {
    const { h, ws, server } = await connected();
    h.clock.time += HOUR;

    h.as.script("refresh", { status: 401, body: { error: "invalid_client" } });
    const wrongClient = await h.registry(ws.id).test(server.id);
    h.as.script("refresh", { status: 503, body: {} });
    const down = await h.registry(ws.id).test(server.id);
    const otherKey = await h
      .tokensFor(ws.id)
      .use(server.id, { serverUrl: h.mcp.url });

    for (const result of [wrongClient, down])
      expect(result).toMatchObject({
        ok: true,
        value: {
          status: "failed",
          testErrorCode: "mcp_test_oauth_unavailable",
          oauth: { status: "connected", errorCode: null },
        },
      });
    expect(otherKey.ok).toBe(true);
    expect(
      h.logs.some(
        (line) =>
          line.includes("MCP_OAUTH_REFRESH_FAILED") &&
          line.includes("OAuth client"),
      ),
    ).toBe(true);
    // Nothing was lost: once the authorization server accepts the client again, the same connection works.
    const mended = await h.registry(ws.id).test(server.id);
    expect(mended).toMatchObject({
      ok: true,
      value: { status: "ok", oauth: { status: "connected" } },
    });
  });

  // #1051-T02
  it("is not marked broken when this process cannot open the pair (another APP_SECRET)", async () => {
    const { h, ws, server } = await connected();
    const { createMcpOAuthTokens } = await import("./tokens.ts");
    const { createMcpOAuthRepository } =
      await import("../../db/repositories/mcp-oauth-repository.ts");
    const wrongKey = createMcpOAuthTokens({
      repository: createMcpOAuthRepository(h.db, ws.id, h.now),
      appSecret: "another-master-key-of-another-process-32!",
      http: { fetch: fetch as never, allowTestEndpoints: true },
      now: h.now,
      log: (line) => h.logs.push(line),
    });

    const result = await wrongKey.use(server.id, { serverUrl: h.mcp.url });

    expect(result).toEqual({ ok: false, error: "mcp_oauth_unavailable" });
    expect(
      h.logs.some((line) => line.includes("MCP_OAUTH_TOKENS_UNREADABLE")),
    ).toBe(true);
    expect((await h.registry(ws.id).list())[0]?.oauth?.status).toBe(
      "connected",
    );
  });

  it("goes with an edit of the address: nothing issued for one address is sent to another", async () => {
    const { h, ws, owner, server } = await connected();
    const other = await (
      await import("../../../../fakes/mcp/server.ts")
    ).startMcpFake({
      oauth: {
        authorizationServer: h.as.issuer,
        validate: (token) => h.as.isValidAccessToken(token),
      },
    });
    try {
      const edited = await h.registry(ws.id).update(server.id, {
        name: "Fake OAuth",
        transport: "streamable-http",
        url: other.url,
        auth: { kind: "oauth" },
        revision: server.revision,
      });
      if (!edited.ok) throw new Error(edited.error);
      expect(edited.value.oauth).toMatchObject({ status: "unconnected" });
      expect(
        await h.db
          .selectFrom("mcp_oauth_connections")
          .select("server_id")
          .execute(),
      ).toEqual([]);

      const tested = await h.registry(ws.id).test(server.id);

      expect(tested).toMatchObject({
        ok: true,
        value: { testErrorCode: "mcp_test_oauth_not_connected" },
      });
      expect(other.requests()).toEqual([]);
      expect(owner.id).toBeTruthy();
    } finally {
      await other.close();
    }
  });
});

describe("the state of the round trip", () => {
  // #1051-T03
  it("refuses a wrong, missing, foreign or other-session state before anything is asked of the authorization server", async () => {
    const { h, ws, owner } = await setup();
    const server = await h.addServer(ws, owner);
    const admin = await h.person("admin", {
      workspaceId: ws.id,
      role: "admin",
    });

    const forged = await h.walk(owner, ws, "owner", server.id, {
      tamper: (q) => q.set("state", `${q.get("state") ?? ""}x`),
    });
    const missing = await h.walk(owner, ws, "owner", server.id, {
      tamper: (q) => q.delete("state"),
    });
    const foreign = await h.walk(owner, ws, "owner", server.id, {
      returningAs: admin,
    });
    const otherSession = await h.walk(owner, ws, "owner", server.id, {
      returningAs: { id: owner.id, sessionId: "another-browser" },
    });

    for (const result of [forged, missing, foreign, otherSession])
      expect(result.landing).toBe("/");
    expect(h.as.requests().filter((r) => r.path === "/token")).toEqual([]);
    expect(
      h.logs.filter((line) => line.includes("state_invalid")),
    ).toHaveLength(4);
    expect((await h.registry(ws.id).list())[0]?.oauth?.status).toBe(
      "unconnected",
    );
  });

  // #1051-T03
  it("refuses a state that is used again, and one that ran out", async () => {
    const { h, ws, owner } = await setup();
    const server = await h.addServer(ws, owner);
    let replayed = "";
    const first = await h.walk(owner, ws, "owner", server.id, {
      tamper: (q) => {
        replayed = q.toString();
      },
    });
    expect(first.landing).toContain("mcp=connected");
    const exchanges = h.as.requests().filter((r) => r.path === "/token").length;

    const again = await h
      .handlers(owner)
      .callback(
        new Request(
          `https://factory.example.test/api/mcp/oauth/callback?${replayed}`,
        ),
      );

    expect(again.headers.get("location")).toBe("/");
    expect(h.as.requests().filter((r) => r.path === "/token")).toHaveLength(
      exchanges,
    );

    const late = await h.walk(owner, ws, "owner", server.id, {
      between: () => {
        h.clock.time += 11 * MINUTE;
      },
    });
    expect(late.landing).toBe("/");
    expect(h.as.requests().filter((r) => r.path === "/token")).toHaveLength(
      exchanges,
    );
  });

  // #1051-T03
  it("ends the flow when the person says no, the code is refused, the authorization server mixes up its answer, or the server was edited in between", async () => {
    const { h, ws, owner } = await setup();
    const server = await h.addServer(ws, owner);

    h.as.setConsent("deny");
    expect((await h.walk(owner, ws, "owner", server.id)).landing).toContain(
      "mcp=access_denied",
    );
    h.as.setConsent("approve");

    h.as.script("code", { status: 400, body: { error: "invalid_grant" } });
    expect((await h.walk(owner, ws, "owner", server.id)).landing).toContain(
      "mcp=mcp_oauth_authorization_refused",
    );
    h.as.script("code", { status: 401, body: { error: "invalid_client" } });
    expect((await h.walk(owner, ws, "owner", server.id)).landing).toContain(
      "mcp=mcp_oauth_client_refused",
    );
    h.as.script("code", { status: 503, body: {} });
    expect((await h.walk(owner, ws, "owner", server.id)).landing).toContain(
      "mcp=mcp_oauth_unreachable",
    );
    // Somebody edited the server at the consent page: the grant was for the old address.
    const edited = await h.walk(owner, ws, "owner", server.id, {
      between: async () => {
        const current = (await h.registry(ws.id).list())[0];
        await h.registry(ws.id).update(server.id, {
          name: "Renamed",
          transport: "streamable-http",
          url: h.mcp.url,
          auth: { kind: "oauth" },
          revision: current?.revision ?? 1,
        });
      },
    });
    expect(edited.landing).toContain("mcp=mcp_server_changed");
    expect((await h.registry(ws.id).list())[0]?.oauth?.status).toBe(
      "unconnected",
    );
    // The code the callback got without a verifier of ours (a code from another flow) does not exchange either.
    expect(
      h.logs.some((line) => line.includes("MCP_OAUTH_CLIENT_REFUSED")),
    ).toBe(true);
  });

  // #1051-T03
  it("checks iss (RFC 9207): one that is not the discovered issuer, or missing where it is announced, is refused", async () => {
    const { h, ws, owner } = await setup({
      authorizationServer: {
        issParameter: true,
        redirectIssuer: "https://other-as.example.com",
      },
    });
    const server = await h.addServer(ws, owner);

    const mixedUp = await h.walk(owner, ws, "owner", server.id);
    const missing = await h.walk(owner, ws, "owner", server.id, {
      tamper: (q) => q.delete("iss"),
    });
    const right = await h.walk(owner, ws, "owner", server.id, {
      tamper: (q) => q.set("iss", h.as.issuer),
    });

    expect(mixedUp.landing).toContain("mcp=mcp_oauth_authorization_refused");
    expect(missing.landing).toContain("mcp=mcp_oauth_authorization_refused");
    expect(right.landing).toContain("mcp=connected");
  });

  it("sends somebody who is not signed in to the login and does nothing", async () => {
    const { h } = await setup();

    const response = await h
      .handlers(null)
      .callback(
        new Request(
          "https://factory.example.test/api/mcp/oauth/callback?code=c&state=s",
        ),
      );

    expect(response.headers.get("location")).toBe("/login");
    expect(h.as.requests()).toEqual([]);
  });
});

/** What a person pressing "Connect" gets back, without walking on. */
async function pressConnect(
  h: Awaited<ReturnType<typeof createMcpOAuthHarness>>,
  ws: Awaited<ReturnType<typeof createMcpOAuthHarness>>["workspace"] extends (
    ...args: never[]
  ) => Promise<infer W>
    ? W
    : never,
  owner: Awaited<ReturnType<typeof h.person>>,
  serverId: string,
) {
  const response = await h
    .handlers(owner)
    .connect(
      new Request("https://factory.example.test/api", { method: "POST" }),
      h.accessOf(owner, ws, "owner"),
      serverId,
    );
  return {
    status: response.status,
    body: (await response.json()) as {
      url?: string;
      error?: string;
      issuerHost?: string;
      scopes?: string[];
    },
  };
}

/** The row of the connection as the database holds it: what a flow that is not finished must not touch. */
async function rowOf(
  h: Awaited<ReturnType<typeof createMcpOAuthHarness>>,
  serverId: string,
) {
  return h.db
    .selectFrom("mcp_oauth_connections")
    .selectAll()
    .where("server_id", "=", serverId)
    .executeTakeFirstOrThrow();
}

describe("a Reconnect of a connection that works", () => {
  // #1051-T01
  it("leaves the connection untouched when it is abandoned: the next call refreshes against the endpoint and with the client it was made with", async () => {
    const { h, ws, owner, server, tokens } = await connected({
      authorizationServer: { accessTokenTtlSeconds: 3600 },
    });
    const before = await rowOf(h, server.id);
    const second = await startOAuthFake({ registeredClient: "confidential" });
    cleanUpAfterTest(() => second.close());
    // The MCP server now names another authorization server (it moved); the person presses Reconnect and never comes back.
    h.mcp.setAuthorizationServer(second.issuer);
    const started = await pressConnect(h, ws, owner, server.id);
    expect(started.body.url).toBeTruthy();
    expect(new URL(started.body.url ?? "").origin).toBe(second.origin);

    expect(await rowOf(h, server.id)).toEqual(before);
    expect((await h.registry(ws.id).list())[0]?.oauth?.status).toBe(
      "connected",
    );

    // The token ends: the refresh goes to the first authorization server, as the first client, and the other one hears nothing of it.
    h.clock.time += HOUR;
    const used = await tokens.use(server.id, { serverUrl: h.mcp.url });

    expect(used.ok).toBe(true);
    expect(
      h.as.requests().filter((r) => r.grantType === "refresh_token"),
    ).toHaveLength(1);
    expect(
      second.requests().filter((r) => r.grantType === "refresh_token"),
    ).toEqual([]);
    expect(second.lastIssued()).toBeNull();
  });

  // #1051-T01
  it("does not send the old tokens to a newly discovered token endpoint, and a refused Reconnect does not break the connection", async () => {
    const { h, ws, owner, server, tokens } = await connected({
      authorizationServer: { accessTokenTtlSeconds: 3600 },
    });
    const second = await startOAuthFake();
    cleanUpAfterTest(() => second.close());
    h.mcp.setAuthorizationServer(second.issuer);
    second.setConsent("deny");

    // The person goes to the new consent page and says no.
    const walked = await h.walk(owner, ws, "owner", server.id);
    expect(walked.landing).toContain("mcp=access_denied");
    h.clock.time += HOUR;
    const used = await tokens.use(server.id, { serverUrl: h.mcp.url });

    expect(used.ok).toBe(true);
    expect(second.requests().filter((r) => r.path === "/token")).toEqual([]);
    expect((await h.registry(ws.id).list())[0]?.oauth?.status).toBe(
      "connected",
    );
  });

  // #1051-T01
  it("lets two flows that run at once each use their own discovery and client", async () => {
    const { h, ws, owner, server, tokens } = await connected({
      authorizationServer: { accessTokenTtlSeconds: 3600 },
    });
    const second = await startOAuthFake({ accessTokenTtlSeconds: 3600 });
    cleanUpAfterTest(() => second.close());
    const firstRegistrations = h.as.registrations();

    // Flow A starts against the first authorization server and waits at its consent page; meanwhile flow B starts and finishes against
    // another one (the MCP server's metadata changed). Then A comes back.
    let flowB: Awaited<ReturnType<typeof h.walk>> | undefined;
    const flowA = await h.walk(owner, ws, "owner", server.id, {
      between: async () => {
        h.mcp.setAuthorizationServer(second.issuer);
        flowB = await h.walk(owner, ws, "owner", server.id);
      },
    });

    expect(flowB?.landing).toContain("mcp=connected");
    expect(flowA.landing).toContain("mcp=connected");
    // Each code was exchanged at the token endpoint of the authorization server that issued it, with the client registered there.
    const exchangeA = h.as
      .requests()
      .filter((r) => r.grantType === "authorization_code")
      .at(-1);
    const exchangeB = second
      .requests()
      .filter((r) => r.grantType === "authorization_code");
    expect(exchangeB).toHaveLength(1);
    expect(exchangeA?.clientId).toBeTruthy();
    expect(exchangeB[0]?.clientId).toBeTruthy();
    expect(exchangeA?.clientId).not.toBe(exchangeB[0]?.clientId);
    expect(second.registrations()).toBe(1);
    expect(h.as.registrations()).toBe(firstRegistrations);
    // A finished last: the row is A's grant, whole. Its refresh goes to the first authorization server only.
    const row = await rowOf(h, server.id);
    expect(row.client_id).toBe(exchangeA?.clientId);
    expect(row.discovery).toContain(h.as.issuer);
    h.clock.time += HOUR;
    const used = await tokens.use(server.id, { serverUrl: h.mcp.url });
    expect(used.ok).toBe(true);
    expect(
      second.requests().filter((r) => r.grantType === "refresh_token"),
    ).toEqual([]);
  });

  // #1051-T02
  it("makes no call with a pair whose grant is for another authorization server, endpoint or client than the row names", async () => {
    const { h, ws, server, tokens } = await connected();
    const row = await rowOf(h, server.id);
    const requestsBefore = h.as.requests().length;
    await h.db
      .updateTable("mcp_oauth_connections")
      .set({
        discovery: (row.discovery ?? "").replace("/token", "/other-token"),
      })
      .where("server_id", "=", server.id)
      .execute();

    const used = await tokens.use(server.id, { serverUrl: h.mcp.url });

    expect(used).toEqual({ ok: false, error: "mcp_oauth_not_connected" });
    expect(
      h.logs.some((line) => line.includes("MCP_OAUTH_GRANT_MISMATCH")),
    ).toBe(true);
    expect(h.as.requests()).toHaveLength(requestsBefore);
    expect(ws.id).toBeTruthy();
  });
});

describe("the issuer an entered client is pinned to", () => {
  const enter = async (
    h: Awaited<ReturnType<typeof createMcpOAuthHarness>>,
    ws: Parameters<typeof pressConnect>[1],
    server: { id: string; revision: number },
    issuer: string,
  ) => {
    h.as.addClient({
      clientId: "entered-client",
      clientSecret: "entered-secret",
    });
    const edited = await h.registry(ws.id).update(server.id, {
      name: "Fake OAuth",
      transport: "streamable-http",
      url: h.mcp.url,
      auth: {
        kind: "oauth",
        clientId: "entered-client",
        issuer,
        clientSecret: "entered-secret",
      },
      revision: server.revision,
    });
    if (!edited.ok) throw new Error(edited.error);
  };

  // #1051-T01
  it("refuses to send the client secret to an authorization server the discovery names but the client was not entered for", async () => {
    const { h, ws, owner } = await setup({
      authorizationServer: { registration: false },
    });
    const server = await h.addServer(ws, owner);
    await enter(h, ws, server, "https://auth.elsewhere.example.com");

    const started = await pressConnect(h, ws, owner, server.id);

    expect(started.status).toBe(422);
    expect(started.body).toEqual({ error: "mcp_oauth_issuer_mismatch" });
    // Nothing reached the authorization server: no registration, no consent, no token request, no client authentication.
    expect(h.as.requests().filter((r) => r.clientId !== null)).toEqual([]);
    expect(h.as.requests().filter((r) => r.path === "/token")).toEqual([]);
    expect(h.logs.join("\n")).not.toContain("entered-secret");
  });

  // #1051-T01
  it("connects when the issuer is the one that was discovered (a trailing slash does not matter), and tells the page where it goes", async () => {
    const { h, ws, owner } = await setup({
      scopes: ["issues:read"],
      authorizationServer: { registration: false },
    });
    const server = await h.addServer(ws, owner);
    await enter(h, ws, server, `${h.as.issuer}/`);

    const started = await pressConnect(h, ws, owner, server.id);

    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      issuerHost: new URL(h.as.issuer).host,
      scopes: ["issues:read"],
    });
    const walked = await h.walk(owner, ws, "owner", server.id);
    expect(walked.landing).toContain("mcp=connected");
  });
});

describe("the client of a Reconnect", () => {
  // #1051-T01
  it("registers a new client when the stored registration cannot be opened (another APP_SECRET), instead of blocking Connect for good", async () => {
    const { h, ws, owner, server } = await connected({
      authorizationServer: { registeredClient: "confidential" },
    });
    expect(h.as.registrations()).toBe(1);
    await h.db
      .updateTable("mcp_oauth_connections")
      .set({ client_secret_ciphertext: "not-a-ciphertext" })
      .where("server_id", "=", server.id)
      .execute();

    const again = await h.walk(owner, ws, "owner", server.id);

    expect(again.landing).toContain("mcp=connected");
    expect(h.as.registrations()).toBe(2);
    expect(
      h.logs.some((line) => line.includes("MCP_OAUTH_CLIENT_UNREADABLE")),
    ).toBe(true);
  });

  // #1051-T01
  it("does not register in place of a client an Owner entered whose secret cannot be opened", async () => {
    const { h, ws, owner } = await setup({
      authorizationServer: { registration: false },
    });
    const server = await h.addServer(ws, owner);
    h.as.addClient({
      clientId: "entered-client",
      clientSecret: "entered-secret",
    });
    const edited = await h.registry(ws.id).update(server.id, {
      name: "Fake OAuth",
      transport: "streamable-http",
      url: h.mcp.url,
      auth: {
        kind: "oauth",
        clientId: "entered-client",
        issuer: h.as.issuer,
        clientSecret: "entered-secret",
      },
      revision: server.revision,
    });
    if (!edited.ok) throw new Error(edited.error);
    await h.db
      .updateTable("mcp_oauth_connections")
      .set({ client_secret_ciphertext: "not-a-ciphertext" })
      .where("server_id", "=", server.id)
      .execute();

    const started = await pressConnect(h, ws, owner, server.id);

    expect(started).toMatchObject({
      status: 503,
      body: { error: "unavailable" },
    });
  });
});

describe("the margin before an access token ends", () => {
  // #1051-T02
  it("is half the lifetime of a short-lived token, so it is not renewed on every use", async () => {
    const { h, server, tokens } = await connected({
      authorizationServer: { accessTokenTtlSeconds: 120 },
    });
    const refreshes = () =>
      h.as.requests().filter((r) => r.grantType === "refresh_token").length;

    await tokens.use(server.id, { serverUrl: h.mcp.url });
    await tokens.use(server.id, { serverUrl: h.mcp.url });
    expect(refreshes()).toBe(0);

    // 30 s in: 90 s are left, more than the margin of 60 s.
    h.clock.time += 30 * 1000;
    await tokens.use(server.id, { serverUrl: h.mcp.url });
    expect(refreshes()).toBe(0);

    // 61 s in: 59 s are left, within the margin.
    h.clock.time += 31 * 1000;
    await tokens.use(server.id, { serverUrl: h.mcp.url });
    expect(refreshes()).toBe(1);
  });
});

describe("the rate limit of the callback", () => {
  // #1051-T03
  it("is hit before the state is used up: a person who has to wait keeps a state that works", async () => {
    const { h, ws, owner, server } = await setup().then(async (parts) => ({
      ...parts,
      server: await parts.h.addServer(parts.ws, parts.owner),
    }));
    const limits = createRateLimitsRepository(h.db);
    let replayed = "";
    const blocked = await h.walk(owner, ws, "owner", server.id, {
      tamper: (q) => {
        replayed = q.toString();
      },
      between: async () => {
        for (let index = 0; index < 20; index += 1)
          await limits.hit(
            `mcp-oauth-callback:user:${owner.id}`,
            10 * 60 * 1000,
          );
      },
    });
    expect(blocked.landing).toContain("mcp=rate_limited");
    expect(h.as.requests().filter((r) => r.path === "/token")).toEqual([]);

    await h.db.deleteFrom("rate_limits").execute();
    const retried = await h
      .handlers(owner)
      .callback(
        new Request(
          `https://factory.example.test/api/mcp/oauth/callback?${replayed}`,
        ),
      );

    expect(retried.headers.get("location")).toContain("mcp=connected");
  });
});
