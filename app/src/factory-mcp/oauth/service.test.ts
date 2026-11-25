// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  ACME,
  ADA,
  BOB,
  EVE,
  REDIRECT,
  RESOURCE,
  SIDE,
  VERIFIER,
  authorizeParams,
  connect,
  createWorld,
  registerClient,
} from "./test-harness.ts";
import { ACCESS_TOKEN_TTL_MS, REFRESH_REUSE_GRACE_MS } from "./service.ts";

describe("dynamic client registration (RFC 7591)", () => {
  // #1144-T30
  it("registers a public client and answers with its metadata", async () => {
    const world = createWorld();
    const result = await world.service.registerClient({
      client_name: "Claude Code",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      // What we do not use is ignored, never stored or shown.
      logo_uri: "https://evil.example/logo.png",
      client_uri: "https://evil.example",
    });
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.response).toMatchObject({
      client_name: "Claude Code",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(result.response.client_id).toMatch(/\S+/);
    expect(result.response).not.toHaveProperty("client_secret");
    expect(world.store.state.clients.size).toBe(1);
  });

  // #1144-T31
  it.each([
    [{ redirect_uris: [] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["javascript:alert(1)"] }, "invalid_redirect_uri"],
    [{ redirect_uris: "https://x.example/cb" }, "invalid_redirect_uri"],
    [
      {
        redirect_uris: Array.from(
          { length: 11 },
          (_, i) => `https://x.example/${i}`,
        ),
      },
      "invalid_redirect_uri",
    ],
    [
      { token_endpoint_auth_method: "client_secret_basic" },
      "invalid_client_metadata",
    ],
    [{ grant_types: ["client_credentials"] }, "invalid_client_metadata"],
    [{ response_types: ["token"] }, "invalid_client_metadata"],
    [{ scope: "factory:read admin" }, "invalid_client_metadata"],
  ])("refuses %j", async (override, code) => {
    const world = createWorld();
    const result = await world.service.registerClient({
      client_name: "x",
      redirect_uris: [REDIRECT],
      ...override,
    });
    expect(result.kind === "error" && result.error).toBe(code);
    expect(world.store.state.clients.size).toBe(0);
  });

  // #1144-T32
  it("cleans the name it will show: control characters out, length cut, a default when empty", async () => {
    const world = createWorld();
    const messy = await world.service.registerClient({
      client_name: "  Trusted‮ App\n\u0000 " + "x".repeat(200),
      redirect_uris: [REDIRECT],
    });
    if (messy.kind !== "ok") throw new Error("expected ok");
    expect(messy.response.client_name).not.toMatch(/[\u0000-\u001f‮]/);
    expect(messy.response.client_name.length).toBeLessThanOrEqual(100);
    const empty = await world.service.registerClient({
      redirect_uris: [REDIRECT],
    });
    expect(empty.kind === "ok" && empty.response.client_name).toBe(
      "Unnamed app",
    );
  });
});

describe("authorization request", () => {
  // #1144-T33
  it("does not redirect for an unknown client or a redirect URI nobody registered", async () => {
    const world = createWorld();
    const { clientId } = await registerClient(world);
    expect(
      await world.service.beginAuthorization(authorizeParams("nobody")),
    ).toMatchObject({ kind: "page_error", code: "invalid_client" });
    expect(
      await world.service.beginAuthorization(
        authorizeParams(clientId, { redirect_uri: "https://evil.example/cb" }),
      ),
    ).toMatchObject({ kind: "page_error", code: "invalid_redirect_uri" });
  });

  // #1144-T34
  it.each([
    [
      { code_challenge: undefined, code_challenge_method: undefined },
      "invalid_request",
    ],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge_method: undefined }, "invalid_request"],
    [{ code_challenge: "short" }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ scope: "factory:read admin" }, "invalid_scope"],
    [{ resource: "https://other.example/api/mcp" }, "invalid_target"],
  ])(
    "answers %j to the client's redirect URI with %s and the state",
    async (override, error) => {
      const world = createWorld();
      const { clientId } = await registerClient(world);
      const outcome = await world.service.beginAuthorization(
        authorizeParams(clientId, override),
      );
      if (outcome.kind !== "redirect_error")
        throw new Error(`got ${outcome.kind}`);
      const target = new URL(outcome.redirectTo);
      expect(`${target.origin}${target.pathname}`).toBe(
        "http://127.0.0.1:33418/callback",
      );
      expect(target.searchParams.get("error")).toBe(error);
      expect(target.searchParams.get("state")).toBe("xyz");
      expect(target.searchParams.get("iss")).toBe(
        "https://factory.example.test",
      );
      expect(world.store.state.requests.size).toBe(0);
    },
  );

  // #1144-T35
  it("stores a valid request without the client being able to read it back", async () => {
    const world = createWorld();
    const { clientId } = await registerClient(world);
    const outcome = await world.service.beginAuthorization(
      authorizeParams(clientId),
    );
    if (outcome.kind !== "request") throw new Error(`got ${outcome.kind}`);
    expect(outcome.requestId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(world.store.state.requests.get(outcome.requestId)).toMatchObject({
      clientId,
      redirectUri: REDIRECT,
      resource: RESOURCE,
      scopes: ["factory:read", "factory:control"],
    });
  });

  // #1144-T36
  it("takes a missing resource as the endpoint itself, and a trailing slash as the same", async () => {
    const world = createWorld();
    const { clientId } = await registerClient(world);
    for (const resource of [undefined, `${RESOURCE}/`]) {
      const outcome = await world.service.beginAuthorization(
        authorizeParams(clientId, { resource }),
      );
      expect(outcome.kind).toBe("request");
    }
  });
});

describe("consent", () => {
  async function pending(
    world = createWorld(),
    overrides: Record<string, string | undefined> = {},
  ) {
    const { clientId } = await registerClient(world);
    const started = await world.service.beginAuthorization(
      authorizeParams(clientId, overrides),
    );
    if (started.kind !== "request") throw new Error(`got ${started.kind}`);
    return { world, clientId, requestId: started.requestId };
  }

  // #1144-T40
  it("shows the person their own workspaces and what the client asked for", async () => {
    const { world, requestId } = await pending();
    const view = await world.service.describeRequest(requestId, ADA.id);
    expect(view).toMatchObject({
      client: { name: "Claude Code" },
      redirectTarget: "127.0.0.1:33418",
      requestedScopes: ["factory:read", "factory:control"],
      allowedScopes: ["factory:read", "factory:control"],
    });
    expect(view?.workspaces.map((w) => [w.slug, w.role])).toEqual([
      ["acme", "owner"],
      ["side", "member"],
    ]);
    expect(
      (await world.service.describeRequest(requestId, EVE.id))?.workspaces,
    ).toEqual([]);
    expect(
      await world.service.describeRequest("x".repeat(32), ADA.id),
    ).toBeNull();
  });

  // #1144-T41
  it("offers only the scopes the client asked for, and both when it named none", async () => {
    const read = await pending(createWorld(), { scope: "factory:read" });
    expect(
      (await read.world.service.describeRequest(read.requestId, ADA.id))
        ?.allowedScopes,
    ).toEqual(["factory:read"]);
    const none = await pending(createWorld(), { scope: undefined });
    expect(
      (await none.world.service.describeRequest(none.requestId, ADA.id))
        ?.allowedScopes,
    ).toEqual(["factory:read", "factory:control"]);
  });

  // #1144-T42
  it("approves one workspace with one scope: a code goes to the registered redirect URI with state and issuer", async () => {
    const { world, requestId } = await pending();
    const decided = await world.service.decide({
      requestId,
      userId: ADA.id,
      decision: "approve",
      workspaceId: ACME.id,
      scope: "factory:read",
    });
    if (decided.kind !== "redirect") throw new Error(`got ${decided.kind}`);
    const target = new URL(decided.redirectTo);
    expect(`${target.origin}${target.pathname}`).toBe(
      "http://127.0.0.1:33418/callback",
    );
    expect(target.searchParams.get("code")).toMatch(/^fmcp_ac_/);
    expect(target.searchParams.get("state")).toBe("xyz");
    expect(target.searchParams.get("iss")).toBe("https://factory.example.test");
    const [grant] = [...world.store.state.grants.values()];
    expect(grant).toMatchObject({
      workspaceId: ACME.id,
      userId: ADA.id,
      scopes: ["factory:read"],
      resource: RESOURCE,
    });
    // The code is stored hashed.
    expect(
      [...world.store.state.codes.keys()].every((hash) =>
        /^[0-9a-f]{64}$/.test(hash),
      ),
    ).toBe(true);
    // The request can be approved once.
    expect(
      await world.service.decide({
        requestId,
        userId: ADA.id,
        decision: "approve",
        workspaceId: ACME.id,
        scope: "factory:read",
      }),
    ).toMatchObject({ kind: "invalid", code: "request_not_found" });
  });

  // #1144-T43
  it("refuses a workspace the person does not belong to, as if it did not exist", async () => {
    const { world, requestId } = await pending();
    for (const userId of [BOB.id, EVE.id]) {
      const refused = await world.service.decide({
        requestId,
        userId,
        decision: "approve",
        workspaceId: SIDE.id,
        scope: "factory:read",
      });
      expect(refused).toMatchObject({
        kind: "invalid",
        code: "workspace_invalid",
      });
    }
    expect(world.store.state.grants.size).toBe(0);
    expect(world.store.state.requests.size).toBe(1);
  });

  // #1144-T44
  it("refuses a scope the client did not ask for, or one of nobody's", async () => {
    const { world, requestId } = await pending(createWorld(), {
      scope: "factory:read",
    });
    for (const scope of ["factory:control", "admin", undefined]) {
      expect(
        await world.service.decide({
          requestId,
          userId: ADA.id,
          decision: "approve",
          workspaceId: ACME.id,
          scope,
        }),
      ).toMatchObject({ kind: "invalid", code: "scope_invalid" });
    }
  });

  // #1144-T45
  it("answers a refusal with access_denied and forgets the request", async () => {
    const { world, requestId } = await pending();
    const decided = await world.service.decide({
      requestId,
      userId: ADA.id,
      decision: "deny",
    });
    if (decided.kind !== "redirect") throw new Error(`got ${decided.kind}`);
    const target = new URL(decided.redirectTo);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("xyz");
    expect(world.store.state.requests.size).toBe(0);
    expect(world.store.state.grants.size).toBe(0);
  });

  // #1144-T46
  it("lets a request expire after ten minutes", async () => {
    const { world, requestId } = await pending();
    world.advance(10 * 60 * 1000 + 1);
    expect(await world.service.describeRequest(requestId, ADA.id)).toBeNull();
    expect(
      await world.service.decide({
        requestId,
        userId: ADA.id,
        decision: "approve",
        workspaceId: ACME.id,
        scope: "factory:read",
      }),
    ).toMatchObject({ kind: "invalid", code: "request_not_found" });
  });
});

describe("token endpoint: authorization code", () => {
  async function code(world = createWorld()) {
    const { clientId } = await registerClient(world);
    const started = await world.service.beginAuthorization(
      authorizeParams(clientId),
    );
    if (started.kind !== "request") throw new Error("request");
    const decided = await world.service.decide({
      requestId: started.requestId,
      userId: ADA.id,
      decision: "approve",
      workspaceId: ACME.id,
      scope: "factory:control",
    });
    if (decided.kind !== "redirect") throw new Error("redirect");
    const value = new URL(decided.redirectTo).searchParams.get(
      "code",
    ) as string;
    const form = (overrides: Record<string, string | undefined> = {}) => {
      const params = new URLSearchParams({
        grant_type: "authorization_code",
        code: value,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
      });
      for (const [key, v] of Object.entries(overrides))
        if (v === undefined) params.delete(key);
        else params.set(key, v);
      return params;
    };
    return { world, clientId, value, form };
  }

  // #1144-T50
  it("gives a short lived access token and a refresh token for the granted scope", async () => {
    const { world, form } = await code();
    const result = await world.service.exchange(form());
    if (result.kind !== "ok") throw new Error(result.error);
    expect(result.body).toMatchObject({
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      scope: "factory:control",
    });
    expect(result.body.access_token).toMatch(/^fmcp_at_/);
    expect(result.body.refresh_token).toMatch(/^fmcp_rt_/);
    expect(ACCESS_TOKEN_TTL_MS).toBeLessThanOrEqual(60 * 60 * 1000);
    // Only hashes are stored, never the token.
    const stored = [...world.store.state.tokens.keys()];
    expect(stored).toHaveLength(2);
    expect(stored.some((key) => key.includes("fmcp_"))).toBe(false);
  });

  // #1144-T51
  it.each([
    ["a wrong verifier", { code_verifier: "A".repeat(43) }],
    ["a missing verifier", { code_verifier: undefined }],
    ["another redirect URI", { redirect_uri: "http://127.0.0.1:33418/other" }],
    ["another client", { client_id: "someone-else" }],
    ["an unknown code", { code: "fmcp_ac_" + "A".repeat(43) }],
    ["a missing code", { code: undefined }],
  ])("refuses %s with invalid_grant", async (_name, override) => {
    const { world, form } = await code();
    const result = await world.service.exchange(form(override));
    expect(result).toMatchObject({ kind: "error", error: "invalid_grant" });
    expect(world.store.state.tokens.size).toBe(0);
  });

  // #1144-T52
  it("refuses a resource that is not this endpoint", async () => {
    const { world, form } = await code();
    expect(
      await world.service.exchange(
        form({ resource: "https://other.example/api/mcp" }),
      ),
    ).toMatchObject({
      kind: "error",
      error: "invalid_target",
    });
  });

  // #1144-T53
  it("refuses an expired code (60 seconds)", async () => {
    const { world, form } = await code();
    world.advance(61_000);
    expect(await world.service.exchange(form())).toMatchObject({
      kind: "error",
      error: "invalid_grant",
    });
  });

  // #1144-T54
  it("revokes the grant when a code is used twice", async () => {
    const { world, form } = await code();
    const first = await world.service.exchange(form());
    if (first.kind !== "ok") throw new Error("first");
    expect(await world.service.exchange(form())).toMatchObject({
      kind: "error",
      error: "invalid_grant",
    });
    const verdict = await world.service.authenticate(first.body.access_token);
    expect(verdict).toMatchObject({ kind: "error", error: "invalid_token" });
  });

  // #1144-T55
  it("refuses another grant type", async () => {
    const { world } = await code();
    expect(
      await world.service.exchange(
        new URLSearchParams({ grant_type: "client_credentials" }),
      ),
    ).toMatchObject({
      kind: "error",
      error: "unsupported_grant_type",
    });
    expect(
      await world.service.exchange(
        new URLSearchParams({ grant_type: "password" }),
      ),
    ).toMatchObject({
      kind: "error",
      error: "unsupported_grant_type",
    });
  });
});

describe("token endpoint: refresh token", () => {
  const refresh = (token: string, clientId: string) =>
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: clientId,
    });

  // #1144-T60
  it("rotates: a new pair, the old refresh token is spent", async () => {
    const world = createWorld();
    const first = await connect(world);
    world.advance(60_000);
    const second = await world.service.exchange(
      refresh(first.refreshToken, first.clientId),
    );
    if (second.kind !== "ok") throw new Error(second.error);
    expect(second.body.refresh_token).not.toBe(first.refreshToken);
    expect(second.body.access_token).not.toBe(first.accessToken);
    expect(second.body.scope).toBe("factory:control");
    expect(
      await world.service.authenticate(second.body.access_token),
    ).toMatchObject({ kind: "ok" });
  });

  // #1144-T61
  it("treats a spent refresh token that comes back late as theft and ends the whole grant", async () => {
    const world = createWorld();
    const first = await connect(world);
    const second = await world.service.exchange(
      refresh(first.refreshToken, first.clientId),
    );
    if (second.kind !== "ok") throw new Error("second");
    world.advance(REFRESH_REUSE_GRACE_MS + 1000);
    expect(
      await world.service.exchange(refresh(first.refreshToken, first.clientId)),
    ).toMatchObject({
      kind: "error",
      error: "invalid_grant",
    });
    expect(
      await world.service.authenticate(second.body.access_token),
    ).toMatchObject({ kind: "error", error: "invalid_token" });
    expect(
      await world.service.exchange(
        refresh(second.body.refresh_token, first.clientId),
      ),
    ).toMatchObject({
      kind: "error",
      error: "invalid_grant",
    });
  });

  // #1144-T62
  it("only refuses a spent refresh token that comes back within seconds (a retry), without ending the grant", async () => {
    const world = createWorld();
    const first = await connect(world);
    const second = await world.service.exchange(
      refresh(first.refreshToken, first.clientId),
    );
    if (second.kind !== "ok") throw new Error("second");
    world.advance(2000);
    expect(
      await world.service.exchange(refresh(first.refreshToken, first.clientId)),
    ).toMatchObject({
      kind: "error",
      error: "invalid_grant",
    });
    expect(
      await world.service.authenticate(second.body.access_token),
    ).toMatchObject({ kind: "ok" });
  });

  // #1144-T63
  it("refuses another client's refresh token and an unknown one", async () => {
    const world = createWorld();
    const first = await connect(world);
    const other = await registerClient(world);
    expect(
      await world.service.exchange(refresh(first.refreshToken, other.clientId)),
    ).toMatchObject({
      kind: "error",
      error: "invalid_grant",
    });
    expect(
      await world.service.exchange(
        refresh("fmcp_rt_" + "A".repeat(43), first.clientId),
      ),
    ).toMatchObject({
      kind: "error",
      error: "invalid_grant",
    });
    // An access token is no refresh token.
    expect(
      await world.service.exchange(refresh(first.accessToken, first.clientId)),
    ).toMatchObject({
      kind: "error",
      error: "invalid_grant",
    });
  });

  // #1144-T64
  it("ends the grant when the person left the workspace", async () => {
    const world = createWorld();
    const first = await connect(world, { user: BOB.id });
    world.members.delete(`${BOB.id}:${ACME.id}`);
    expect(
      await world.service.exchange(refresh(first.refreshToken, first.clientId)),
    ).toMatchObject({
      kind: "error",
      error: "invalid_grant",
    });
    expect(await world.service.authenticate(first.accessToken)).toMatchObject({
      kind: "error",
      error: "invalid_token",
    });
  });

  // #1144-T65
  it("lets a grant live 90 days at most, however often it is refreshed", async () => {
    const world = createWorld();
    let current = await connect(world);
    for (let day = 25; day <= 75; day += 25) {
      world.advance(25 * 24 * 3600 * 1000);
      const next = await world.service.exchange(
        refresh(current.refreshToken, current.clientId),
      );
      if (next.kind !== "ok") throw new Error(`refresh on day ${day}`);
      current = { ...current, refreshToken: next.body.refresh_token };
    }
    world.advance(20 * 24 * 3600 * 1000);
    expect(
      await world.service.exchange(
        refresh(current.refreshToken, current.clientId),
      ),
    ).toMatchObject({
      kind: "error",
      error: "invalid_grant",
    });
  });
});

describe("authenticate (the audience, the clock, revocation)", () => {
  // #1144-T70
  it("knows who is calling: person, workspace, role, scope and client", async () => {
    const world = createWorld();
    const { accessToken } = await connect(world, { scope: "factory:read" });
    const verdict = await world.service.authenticate(accessToken);
    if (verdict.kind !== "ok") throw new Error(verdict.error);
    expect(verdict.principal).toMatchObject({
      user: { id: ADA.id, name: "Ada" },
      workspace: { id: ACME.id, slug: "acme", name: "Acme" },
      role: "owner",
      scopes: ["factory:read"],
      client: { name: "Claude Code" },
    });
  });

  // #1144-T71
  it("refuses no token, an unknown one, and a token of the wrong kind", async () => {
    const world = createWorld();
    const { refreshToken } = await connect(world);
    expect(await world.service.authenticate(null)).toMatchObject({
      kind: "error",
      error: "invalid_request",
    });
    expect(await world.service.authenticate("")).toMatchObject({
      kind: "error",
      error: "invalid_request",
    });
    expect(await world.service.authenticate("garbage")).toMatchObject({
      kind: "error",
      error: "invalid_token",
    });
    expect(
      await world.service.authenticate("fmcp_at_" + "A".repeat(43)),
    ).toMatchObject({ kind: "error", error: "invalid_token" });
    expect(await world.service.authenticate(refreshToken)).toMatchObject({
      kind: "error",
      error: "invalid_token",
    });
  });

  // #1144-T72
  it("refuses an expired token", async () => {
    const world = createWorld();
    const { accessToken } = await connect(world);
    world.advance(ACCESS_TOKEN_TTL_MS - 1000);
    expect(await world.service.authenticate(accessToken)).toMatchObject({
      kind: "ok",
    });
    world.advance(2000);
    expect(await world.service.authenticate(accessToken)).toMatchObject({
      kind: "error",
      error: "invalid_token",
    });
  });

  // #1144-T73
  it("refuses a token made for another audience", async () => {
    const world = createWorld();
    const { accessToken } = await connect(world);
    const [grant] = [...world.store.state.grants.values()];
    world.store.state.grants.set(grant!.id, {
      ...grant!,
      resource: "https://other.example/api/mcp",
    });
    expect(await world.service.authenticate(accessToken)).toMatchObject({
      kind: "error",
      error: "invalid_token",
    });
  });

  // #1144-T74
  it("refuses a token the moment its grant is revoked", async () => {
    const world = createWorld();
    const { accessToken } = await connect(world);
    const [grant] = [...world.store.state.grants.values()];
    expect(
      await world.store
        .scoped(ACME.id)
        .revoke(grant!.id, world.clock.now.toISOString()),
    ).toBe(true);
    expect(await world.service.authenticate(accessToken)).toMatchObject({
      kind: "error",
      error: "invalid_token",
    });
  });

  // #1144-T75
  it("refuses a token once the person is no longer a member, and ends the grant", async () => {
    const world = createWorld();
    const { accessToken } = await connect(world, { user: BOB.id });
    world.members.delete(`${BOB.id}:${ACME.id}`);
    expect(await world.service.authenticate(accessToken)).toMatchObject({
      kind: "error",
      error: "invalid_token",
    });
    expect(await world.store.scoped(ACME.id).list()).toEqual([]);
  });

  // #1144-T76
  it("follows the role the person has now, not the one at the consent", async () => {
    const world = createWorld();
    const { accessToken } = await connect(world);
    world.members.set(`${ADA.id}:${ACME.id}`, "member");
    const verdict = await world.service.authenticate(accessToken);
    expect(verdict.kind === "ok" && verdict.principal.role).toBe("member");
  });
});

describe("revocation (RFC 7009) and the list of connected apps", () => {
  // #1144-T80
  it("revokes the whole grant by either token", async () => {
    const world = createWorld();
    const first = await connect(world);
    await world.service.revoke(first.refreshToken);
    expect(await world.service.authenticate(first.accessToken)).toMatchObject({
      kind: "error",
    });
    const second = await connect(world);
    await world.service.revoke(second.accessToken);
    expect(await world.service.authenticate(second.accessToken)).toMatchObject({
      kind: "error",
    });
    // Unknown tokens are not an error (RFC 7009 section 2.2).
    await expect(world.service.revoke("whatever")).resolves.toBeUndefined();
  });

  // #1144-T81
  it("lists the connected apps of one workspace only, and revokes only inside it", async () => {
    const world = createWorld();
    await connect(world);
    await connect(world, { workspaceId: SIDE.id, scope: "factory:read" });
    const acme = await world.store.scoped(ACME.id).list();
    expect(acme).toHaveLength(1);
    expect(acme[0]).toMatchObject({
      clientName: "Claude Code",
      userName: "Ada",
      scopes: ["factory:control"],
    });
    const sideGrant = (await world.store.scoped(SIDE.id).list())[0]!;
    expect(
      await world.store
        .scoped(ACME.id)
        .revoke(sideGrant.id, world.clock.now.toISOString()),
    ).toBe(false);
    expect(await world.store.scoped(SIDE.id).list()).toHaveLength(1);
    expect(
      await world.store
        .scoped(SIDE.id)
        .revoke(sideGrant.id, world.clock.now.toISOString()),
    ).toBe(true);
    expect(await world.store.scoped(SIDE.id).list()).toEqual([]);
  });
});
