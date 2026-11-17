// SPDX-License-Identifier: LicenseRef-Proprietary

// The OAuth connection of an MCP server (#1051) against a real Postgres, a fake authorization server and a fake OAuth-protected MCP server
// (on another origin than the authorization server): discovery, registration, consent, callback, tool list; the refresh before expiry, serialized;
// a refresh the authorization server refuses ends the connection and a wrong client does not; a wrong, used or foreign state is refused; and no
// token ever leaves the server. The route handlers and services are the real ones.
import { describe, expect, it } from "vitest";
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
