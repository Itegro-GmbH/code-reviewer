// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth/access-policy.ts";
import { createOAuthHandlers } from "./http.ts";
import {
  ACME,
  ADA,
  ISSUER,
  REDIRECT,
  RESOURCE,
  VERIFIER,
  authorizeParams,
  createWorld,
  registerClient,
} from "./test-harness.ts";

const USER: SessionUser = {
  id: ADA.id,
  name: ADA.name,
  email: ADA.email,
  isInstanceAdmin: false,
  githubLogin: null,
  githubId: null,
  image: null,
};

function setup(
  options: { signedIn?: boolean; registrationAllowed?: boolean } = {},
) {
  const world = createWorld();
  const handlers = createOAuthHandlers({
    service: world.service,
    baseUrl: ISSUER,
    allowRegistration: async () => options.registrationAllowed ?? true,
    currentUser: async () => (options.signedIn === false ? null : USER),
  });
  return { world, handlers };
}

const jsonRequest = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const formRequest = (
  url: string,
  params: URLSearchParams,
  headers: Record<string, string> = {},
) =>
  new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: params.toString(),
  });

describe("discovery documents", () => {
  // #1144-T100
  it("names the authorization server in the protected resource metadata (RFC 9728)", async () => {
    const { handlers } = setup();
    const response = handlers.protectedResource();
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["factory:read", "factory:control"],
      bearer_methods_supported: ["header"],
      resource_name: "Factory MCP",
    });
  });

  // #1144-T101
  it("states what the authorization server does and does not support (RFC 8414)", async () => {
    const { handlers } = setup();
    const metadata = (await handlers.authorizationServer().json()) as Record<
      string,
      unknown
    >;
    expect(metadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/api/oauth/token`,
      registration_endpoint: `${ISSUER}/api/oauth/register`,
      revocation_endpoint: `${ISSUER}/api/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  });
});

describe("registration endpoint", () => {
  // #1144-T102
  it("answers 201 with the client and never caches it", async () => {
    const { handlers } = setup();
    const response = await handlers.register(
      jsonRequest(`${ISSUER}/api/oauth/register`, {
        client_name: "Cursor",
        redirect_uris: [REDIRECT],
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      client_name: "Cursor",
      token_endpoint_auth_method: "none",
    });
  });

  // #1144-T103
  it("refuses a bad body with an RFC 7591 error", async () => {
    const { handlers } = setup();
    const wrongType = await handlers.register(
      new Request(`${ISSUER}/api/oauth/register`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
    );
    expect(wrongType.status).toBe(400);
    const notJson = await handlers.register(
      new Request(`${ISSUER}/api/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(notJson.status).toBe(400);
    const badUri = await handlers.register(
      jsonRequest(`${ISSUER}/api/oauth/register`, {
        redirect_uris: ["http://evil.example/cb"],
      }),
    );
    expect(badUri.status).toBe(400);
    expect(await badUri.json()).toMatchObject({
      error: "invalid_redirect_uri",
    });
    const huge = await handlers.register(
      jsonRequest(`${ISSUER}/api/oauth/register`, {
        client_name: "x".repeat(20_000),
        redirect_uris: [REDIRECT],
      }),
    );
    expect(huge.status).toBe(400);
  });

  // #1144-T104
  it("answers 429 when the instance's counter says no, and registers nothing", async () => {
    const { handlers, world } = setup({ registrationAllowed: false });
    const response = await handlers.register(
      jsonRequest(`${ISSUER}/api/oauth/register`, {
        redirect_uris: [REDIRECT],
      }),
    );
    expect(response.status).toBe(429);
    expect(world.store.state.clients.size).toBe(0);
  });
});

describe("authorization endpoint", () => {
  const url = (params: URLSearchParams) =>
    new Request(`${ISSUER}/oauth/authorize?${params}`);

  // #1144-T105
  it("shows an error page, without any redirect, for an unknown client or an unregistered redirect URI", async () => {
    const { handlers, world } = setup();
    const { clientId } = await registerClient(world);
    for (const params of [
      authorizeParams("nobody"),
      authorizeParams(clientId, { redirect_uri: "https://evil.example/cb" }),
    ]) {
      const response = await handlers.authorize(url(params));
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-type")).toContain("text/html");
    }
  });

  // #1144-T106
  it("sends a person with no session to the sign in, carrying the request, and a signed in one to the consent page", async () => {
    const out = setup({ signedIn: false });
    const { clientId } = await registerClient(out.world);
    const toLogin = await out.handlers.authorize(
      url(authorizeParams(clientId)),
    );
    expect(toLogin.status).toBe(303);
    expect(toLogin.headers.get("location")).toMatch(
      /^\/login\?oauth=[A-Za-z0-9_-]{32}$/,
    );

    const inn = setup();
    const client = await registerClient(inn.world);
    const toConsent = await inn.handlers.authorize(
      url(authorizeParams(client.clientId)),
    );
    expect(toConsent.headers.get("location")).toMatch(
      /^\/oauth\/consent\?request=[A-Za-z0-9_-]{32}$/,
    );
  });

  // #1144-T107
  it("answers a request without PKCE to the client's redirect URI with an error and the state", async () => {
    const { handlers, world } = setup();
    const { clientId } = await registerClient(world);
    const response = await handlers.authorize(
      url(
        authorizeParams(clientId, {
          code_challenge: undefined,
          code_challenge_method: undefined,
        }),
      ),
    );
    const target = new URL(response.headers.get("location") as string);
    expect(target.origin + target.pathname).toBe(
      "http://127.0.0.1:33418/callback",
    );
    expect(target.searchParams.get("error")).toBe("invalid_request");
    expect(target.searchParams.get("state")).toBe("xyz");
  });
});

describe("consent and token endpoints, end to end", () => {
  async function toConsent(
    handlers: ReturnType<typeof setup>["handlers"],
    clientId: string,
  ) {
    const response = await handlers.authorize(
      new Request(`${ISSUER}/oauth/authorize?${authorizeParams(clientId)}`),
    );
    return new URL(
      response.headers.get("location") as string,
      ISSUER,
    ).searchParams.get("request") as string;
  }

  // #1144-T108
  it("runs consent, token, refresh and revoke over HTTP", async () => {
    const { handlers, world } = setup();
    const { clientId } = await registerClient(world);
    const requestId = await toConsent(handlers, clientId);
    const consent = await handlers.consent(
      formRequest(
        `${ISSUER}/api/oauth/consent`,
        new URLSearchParams({
          request: requestId,
          decision: "approve",
          workspace: ACME.id,
          scope: "factory:control",
        }),
        { "sec-fetch-site": "same-origin" },
      ),
      USER,
    );
    expect(consent.status).toBe(303);
    const code = new URL(
      consent.headers.get("location") as string,
    ).searchParams.get("code") as string;

    const token = await handlers.token(
      formRequest(
        `${ISSUER}/api/oauth/token`,
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: VERIFIER,
          resource: RESOURCE,
        }),
      ),
    );
    expect(token.status).toBe(200);
    expect(token.headers.get("cache-control")).toBe("no-store");
    const body = (await token.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      scope: string;
    };
    expect(body).toMatchObject({
      token_type: "Bearer",
      scope: "factory:control",
    });

    const refreshed = await handlers.token(
      formRequest(
        `${ISSUER}/api/oauth/token`,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: body.refresh_token,
          client_id: clientId,
        }),
      ),
    );
    expect(refreshed.status).toBe(200);

    const revoked = await handlers.revoke(
      formRequest(
        `${ISSUER}/api/oauth/revoke`,
        new URLSearchParams({ token: body.access_token }),
      ),
    );
    expect(revoked.status).toBe(200);
    const after = await handlers.token(
      formRequest(
        `${ISSUER}/api/oauth/token`,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: body.refresh_token,
          client_id: clientId,
        }),
      ),
    );
    expect(after.status).toBe(400);
    expect(await after.json()).toMatchObject({ error: "invalid_grant" });
  });

  // #1144-T109
  it("refuses a consent post from another site, and a malformed one", async () => {
    const { handlers, world } = setup();
    const { clientId } = await registerClient(world);
    const requestId = await toConsent(handlers, clientId);
    const params = new URLSearchParams({
      request: requestId,
      decision: "approve",
      workspace: ACME.id,
      scope: "factory:read",
    });
    const crossSite = await handlers.consent(
      formRequest(`${ISSUER}/api/oauth/consent`, params, {
        "sec-fetch-site": "cross-site",
      }),
      USER,
    );
    expect(crossSite.status).toBe(403);
    expect(world.store.state.grants.size).toBe(0);
    const noDecision = await handlers.consent(
      formRequest(
        `${ISSUER}/api/oauth/consent`,
        new URLSearchParams({ request: requestId }),
      ),
      USER,
    );
    expect(noDecision.status).toBe(400);
    const json = await handlers.consent(
      jsonRequest(`${ISSUER}/api/oauth/consent`, {}),
      USER,
    );
    expect(json.status).toBe(400);
  });

  // #1144-T110
  it("sends a wrong choice back to the consent page with a code, and nothing is granted", async () => {
    const { handlers, world } = setup();
    const { clientId } = await registerClient(world);
    const requestId = await toConsent(handlers, clientId);
    const response = await handlers.consent(
      formRequest(
        `${ISSUER}/api/oauth/consent`,
        new URLSearchParams({
          request: requestId,
          decision: "approve",
          workspace: "ws-not-mine",
          scope: "factory:read",
        }),
      ),
      USER,
    );
    expect(response.headers.get("location")).toBe(
      `/oauth/consent?request=${requestId}&error=workspace_invalid`,
    );
    expect(world.store.state.grants.size).toBe(0);
  });

  // #1144-T111
  it("answers token errors as RFC 6749 JSON, and refuses the wrong content type", async () => {
    const { handlers } = setup();
    const wrongType = await handlers.token(
      new Request(`${ISSUER}/api/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toMatchObject({ error: "invalid_request" });
    const unsupported = await handlers.token(
      formRequest(
        `${ISSUER}/api/oauth/token`,
        new URLSearchParams({ grant_type: "password" }),
      ),
    );
    expect(await unsupported.json()).toMatchObject({
      error: "unsupported_grant_type",
    });
  });

  // #1144-T112
  it("answers a preflight for the public endpoints", () => {
    const { handlers } = setup();
    const response = handlers.preflight();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
