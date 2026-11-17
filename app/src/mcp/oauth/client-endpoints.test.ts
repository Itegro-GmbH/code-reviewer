// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, describe, expect, it } from "vitest";
import { startOAuthFake, type OAuthFake } from "../../../../fakes/mcp/oauth.ts";
import type { McpOAuthDiscovery } from "../../db/repositories/mcp-oauth-repository.ts";
import { createGuardedFetch } from "../../dispatch/guarded-fetch.ts";
import { buildAuthorizationUrl } from "./authorization-url.ts";
import type { OAuthHttp } from "./endpoint-http.ts";
import { createPkce } from "./pkce.ts";
import { registerClient } from "./registration.ts";
import { exchangeCode, refreshGrant } from "./token-endpoint.ts";

const fakes: OAuthFake[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

const http: OAuthHttp = {
  fetch: createGuardedFetch({ allowLoopback: true }),
  allowTestEndpoints: true,
  deadlineMs: 5000,
};
const REDIRECT = "https://factory.example.test/api/mcp/oauth/callback";
const RESOURCE = "https://mcp.example.com/mcp";

async function setup(...args: Parameters<typeof startOAuthFake>) {
  const as = await startOAuthFake(...args);
  fakes.push(as);
  const discovery: McpOAuthDiscovery = {
    resource: RESOURCE,
    issuer: as.issuer,
    authorizationEndpoint: `${as.origin}/authorize`,
    tokenEndpoint: `${as.origin}/token`,
    registrationEndpoint: `${as.origin}/register`,
    scopes: ["issues:read"],
    issParameter: false,
    authMethods: ["none", "client_secret_basic", "client_secret_post"],
  };
  return { as, discovery };
}

/** What the person's browser does: visits the authorization address and reads the code from the redirect. */
async function consent(url: string): Promise<URL> {
  const response = await fetch(url, { redirect: "manual" });
  return new URL(response.headers.get("location") ?? "");
}

describe("dynamic client registration (RFC 7591)", () => {
  // #1051-T01
  it("registers a public client for the callback address and returns its id", async () => {
    const { as, discovery } = await setup();

    const result = await registerClient(
      discovery,
      { redirectUri: REDIRECT, clientName: "Test product" },
      http,
    );

    expect(result).toMatchObject({
      ok: true,
      client: { clientSecret: null, authMethod: "none" },
    });
    expect(as.registrations()).toBe(1);
  });

  it("keeps the secret and the method of a confidential client", async () => {
    const { discovery } = await setup({ registeredClient: "confidential" });

    const result = await registerClient(
      discovery,
      { redirectUri: REDIRECT, clientName: "Test product" },
      http,
    );

    expect(result).toMatchObject({
      ok: true,
      client: { authMethod: "client_secret_basic" },
    });
    expect(result.ok && result.client.clientSecret).toMatch(/^secret-/);
  });

  it("says so when the authorization server has no registration endpoint or refuses it", async () => {
    const { as, discovery } = await setup({ registration: false });

    expect(
      await registerClient(
        { ...discovery, registrationEndpoint: null },
        { redirectUri: REDIRECT, clientName: "x" },
        http,
      ),
    ).toEqual({ ok: false, code: "mcp_oauth_client_required" });
    expect(
      await registerClient(
        discovery,
        { redirectUri: REDIRECT, clientName: "x" },
        http,
      ),
    ).toEqual({ ok: false, code: "mcp_oauth_registration_failed" });
    expect(as.registrations()).toBe(0);
  });
});

describe("the authorization address", () => {
  it("carries PKCE S256, the state, the redirect address, the resource (RFC 8707) and the scopes", () => {
    const url = new URL(
      buildAuthorizationUrl(
        {
          resource: RESOURCE,
          issuer: "https://as.example.com",
          authorizationEndpoint: "https://as.example.com/authorize?tenant=7",
          tokenEndpoint: "https://as.example.com/token",
          registrationEndpoint: null,
          scopes: ["a", "b:c"],
          issParameter: false,
          authMethods: [],
        },
        {
          clientId: "c-1",
          redirectUri: REDIRECT,
          state: "s-1",
          challenge: "ch-1",
        },
      ),
    );

    expect(url.origin + url.pathname).toBe("https://as.example.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tenant: "7",
      response_type: "code",
      client_id: "c-1",
      redirect_uri: REDIRECT,
      state: "s-1",
      code_challenge: "ch-1",
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "a b:c",
    });
  });
});

describe("the token endpoint", () => {
  async function registered(
    options: Parameters<typeof startOAuthFake>[0] = {},
  ) {
    const { as, discovery } = await setup(options);
    const result = await registerClient(
      discovery,
      { redirectUri: REDIRECT, clientName: "x" },
      http,
    );
    if (!result.ok) throw new Error("registration failed");
    const { client } = result;
    return {
      as,
      discovery,
      auth: {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        method: client.authMethod,
      },
    };
  }

  async function code(
    as: OAuthFake,
    discovery: McpOAuthDiscovery,
    clientId: string,
  ) {
    const pkce = createPkce();
    const redirect = await consent(
      buildAuthorizationUrl(discovery, {
        clientId,
        redirectUri: REDIRECT,
        state: "s",
        challenge: pkce.challenge,
      }),
    );
    expect(as.requests().at(-1)?.resource).toBe(RESOURCE);
    return {
      code: redirect.searchParams.get("code") ?? "",
      verifier: pkce.verifier,
    };
  }

  // #1051-T01
  it("exchanges the code with the verifier and the resource, and returns the pair", async () => {
    const { as, discovery, auth } = await registered();
    const { code: value, verifier } = await code(as, discovery, auth.clientId);

    const grant = await exchangeCode(
      discovery,
      auth,
      { code: value, redirectUri: REDIRECT, verifier },
      http,
    );

    expect(grant).toMatchObject({
      ok: true,
      grant: { expiresInSeconds: 3600 },
    });
    expect(grant.ok && grant.grant.accessToken).toBe(
      as.lastIssued()?.accessToken,
    );
    expect(grant.ok && grant.grant.refreshToken).toBe(
      as.lastIssued()?.refreshToken,
    );
    expect(as.requests().at(-1)).toMatchObject({
      grantType: "authorization_code",
      resource: RESOURCE,
      redirectUri: REDIRECT,
    });
  });

  it("is refused for another verifier, and a used code cannot be used again", async () => {
    const { as, discovery, auth } = await registered();
    const { code: value, verifier } = await code(as, discovery, auth.clientId);

    const wrong = await exchangeCode(
      discovery,
      auth,
      { code: value, redirectUri: REDIRECT, verifier: `${verifier}x` },
      http,
    );
    const replay = await exchangeCode(
      discovery,
      auth,
      { code: value, redirectUri: REDIRECT, verifier },
      http,
    );

    expect(wrong).toEqual({ ok: false, kind: "refused" });
    expect(replay).toEqual({ ok: false, kind: "refused" });
  });

  // #1051-T02
  it("refreshes with the resource, rotates the refresh token, and a used one is refused as invalid_grant", async () => {
    const { as, discovery, auth } = await registered();
    const { code: value, verifier } = await code(as, discovery, auth.clientId);
    const first = await exchangeCode(
      discovery,
      auth,
      { code: value, redirectUri: REDIRECT, verifier },
      http,
    );
    if (!first.ok || first.grant.refreshToken === null)
      throw new Error("no pair");

    const second = await refreshGrant(
      discovery,
      auth,
      first.grant.refreshToken,
      http,
    );
    const again = await refreshGrant(
      discovery,
      auth,
      first.grant.refreshToken,
      http,
    );

    expect(second).toMatchObject({ ok: true });
    expect(second.ok && second.grant.accessToken).not.toBe(
      first.grant.accessToken,
    );
    expect(as.requests().at(-2)).toMatchObject({
      grantType: "refresh_token",
      resource: RESOURCE,
    });
    expect(again).toEqual({ ok: false, kind: "refused" });
  });

  // #1051-T02
  it("tells a refused grant from a client the server does not accept, a failing server and an unreachable one", async () => {
    const { as, discovery, auth } = await registered({
      registeredClient: "confidential",
    });

    const wrongClient = await refreshGrant(
      discovery,
      { ...auth, clientSecret: "not-the-secret" },
      "rt-whatever",
      http,
    );
    as.script("refresh", { status: 503, body: {} });
    const failing = await refreshGrant(discovery, auth, "rt-whatever", http);
    as.script("refresh", { status: 200, body: { nothing: true } });
    const nonsense = await refreshGrant(discovery, auth, "rt-whatever", http);
    as.script("refresh", { status: 400, body: { error: "invalid_client" } });
    const refusedClient = await refreshGrant(
      discovery,
      auth,
      "rt-whatever",
      http,
    );
    const unreachable = await refreshGrant(
      { ...discovery, tokenEndpoint: "http://127.0.0.1:9/token" },
      auth,
      "rt-whatever",
      http,
    );

    expect(wrongClient).toEqual({ ok: false, kind: "client" });
    expect(failing).toEqual({ ok: false, kind: "unavailable" });
    expect(nonsense).toEqual({ ok: false, kind: "unavailable" });
    expect(refusedClient).toEqual({ ok: false, kind: "client" });
    expect(unreachable).toEqual({ ok: false, kind: "unavailable" });
  });

  it("authenticates a client with a secret by Basic or in the body, as the method says", async () => {
    const { as, discovery, auth } = await registered({
      registeredClient: "confidential",
    });
    const { code: value, verifier } = await code(as, discovery, auth.clientId);

    await exchangeCode(
      discovery,
      auth,
      { code: value, redirectUri: REDIRECT, verifier },
      http,
    );
    expect(as.requests().at(-1)?.clientAuth).toBe("basic");
    const viaBody = await refreshGrant(
      discovery,
      { ...auth, method: "client_secret_post" },
      as.lastIssued()?.refreshToken ?? "",
      http,
    );

    expect(viaBody.ok).toBe(true);
    expect(as.requests().at(-1)?.clientAuth).toBe("post");
  });

  it("does not call a token endpoint at a private address", async () => {
    const { discovery, auth } = await registered();

    const result = await refreshGrant(
      { ...discovery, tokenEndpoint: "http://169.254.169.254/token" },
      auth,
      "rt-x",
      http,
    );

    expect(result).toEqual({ ok: false, kind: "address_refused" });
  });
});
