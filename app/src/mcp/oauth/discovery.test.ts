// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, describe, expect, it } from "vitest";
import { startMcpFake, type McpFake } from "../../../../fakes/mcp/server.ts";
import {
  startOAuthFake,
  type OAuthFakeOptions,
} from "../../../../fakes/mcp/oauth.ts";
import { createGuardedFetch } from "../../dispatch/guarded-fetch.ts";
import {
  canonicalResource,
  discoverOAuth,
  parseChallenge,
} from "./discovery.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function setup(
  authorization: OAuthFakeOptions = {},
  protect: {
    challenge?: "header" | "bare";
    scopes?: string[];
    claimedResource?: string;
  } = {},
) {
  // Two servers, two ports: the authorization server is never on the origin of the MCP server.
  const as = await startOAuthFake(authorization);
  closers.push(() => as.close());
  const mcp: McpFake = await startMcpFake({
    oauth: {
      authorizationServer: as.issuer,
      validate: (token) => as.isValidAccessToken(token),
      ...protect,
    },
  });
  closers.push(() => mcp.close());
  return { as, mcp };
}

const run = (
  url: string,
  transport: "streamable-http" | "sse" = "streamable-http",
  over: {
    allowTestEndpoints?: boolean;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
  } = {},
) =>
  discoverOAuth(
    { url, transport },
    {
      fetch: over.fetch ?? createGuardedFetch({ allowLoopback: true }),
      allowTestEndpoints: over.allowTestEndpoints ?? true,
      deadlineMs: 5000,
    },
  );

describe("the discovery of the authorization server of an MCP server", () => {
  // #1051-T01
  it("follows the 401 of the server to its protected-resource metadata and on to the authorization server's metadata", async () => {
    const { as, mcp } = await setup(
      {},
      { scopes: ["issues:read", "issues:write"] },
    );

    const result = await run(mcp.url);

    expect(result).toEqual({
      ok: true,
      discovery: {
        resource: mcp.url,
        issuer: as.issuer,
        authorizationEndpoint: `${as.origin}/authorize`,
        tokenEndpoint: `${as.origin}/token`,
        registrationEndpoint: `${as.origin}/register`,
        scopes: ["issues:read", "issues:write"],
        issParameter: false,
        authMethods: ["none", "client_secret_basic", "client_secret_post"],
      },
    });
    // The first request carried no credential, and the server was asked nothing else.
    expect(mcp.requests().map((r) => [r.method, r.path])).toEqual([
      ["POST", "/mcp"],
      ["GET", "/.well-known/oauth-protected-resource/mcp"],
    ]);
  });

  it("finds the metadata at the well-known place when the 401 names none, for the legacy SSE address too", async () => {
    const { mcp } = await setup({}, { challenge: "bare" });

    const result = await run(mcp.sseUrl, "sse");

    expect(result).toMatchObject({
      ok: true,
      discovery: { resource: mcp.sseUrl },
    });
    expect(mcp.requests().map((r) => [r.method, r.path])).toEqual([
      ["GET", "/sse"],
      ["GET", "/.well-known/oauth-protected-resource/sse"],
    ]);
  });

  it("reads OpenID Connect discovery, inserted before or appended to an issuer path", async () => {
    for (const metadata of ["openid", "openid-appended"] as const) {
      const { as, mcp } = await setup({ metadata, issuerPath: "/tenant" });

      const result = await run(mcp.url);

      expect(result).toMatchObject({
        ok: true,
        discovery: { issuer: `${as.origin}/tenant` },
      });
    }
  });

  it("accepts an authorization server on another origin than the MCP server, and checks the address of each document", async () => {
    const { mcp, as } = await setup();
    const guarded = createGuardedFetch({ allowLoopback: true });
    const asked: string[] = [];

    const result = await run(mcp.url, "streamable-http", {
      fetch: (url, init) => {
        asked.push(url);
        return guarded(url, init);
      },
    });

    expect(result.ok).toBe(true);
    expect(new URL(as.origin).origin).not.toBe(new URL(mcp.origin).origin);
    expect(asked.some((url) => url.startsWith(as.origin))).toBe(true);
  });

  it("refuses a resource that is not the server it was found for", async () => {
    const { mcp } = await setup(
      {},
      { claimedResource: "https://evil.example.com/mcp" },
    );

    expect(await run(mcp.url)).toEqual({
      ok: false,
      code: "mcp_oauth_discovery_failed",
    });
  });

  it("refuses an authorization server whose metadata names another issuer", async () => {
    const { mcp } = await setup({
      claimedIssuer: "https://elsewhere.example.com",
    });

    expect(await run(mcp.url)).toEqual({
      ok: false,
      code: "mcp_oauth_discovery_failed",
    });
  });

  it("refuses an authorization server without S256 and says so", async () => {
    const { mcp } = await setup({ pkceMethods: ["plain"] });

    expect(await run(mcp.url)).toEqual({
      ok: false,
      code: "mcp_oauth_pkce_unsupported",
    });
  });

  it("refuses every address that is plain http or private when the test flag is off, before any request", async () => {
    const { mcp } = await setup();
    let calls = 0;

    const result = await run(mcp.url, "streamable-http", {
      allowTestEndpoints: false,
      fetch: () => {
        calls += 1;
        return Promise.reject(new Error("no request may be made"));
      },
    });

    expect(result).toEqual({ ok: false, code: "mcp_oauth_address_refused" });
    expect(calls).toBe(0);
  });

  it("refuses an authorization server whose endpoint is a private address", async () => {
    // The metadata is served by the fake; the guard that matters here is the address in it.
    const { mcp, as } = await setup();
    const guarded = createGuardedFetch({ allowLoopback: true });

    const result = await run(mcp.url, "streamable-http", {
      fetch: async (url, init) => {
        const response = await guarded(url, init);
        if (!url.includes("/.well-known/oauth-authorization-server"))
          return response;
        const document = (await response.json()) as Record<string, unknown>;
        return Response.json({
          ...document,
          token_endpoint: "http://169.254.169.254/token",
        });
      },
    });

    expect(as.requests().length).toBeGreaterThan(0);
    expect(result).toEqual({ ok: false, code: "mcp_oauth_address_refused" });
  });

  it("does not follow a redirect of a discovery document", async () => {
    const { mcp } = await setup();
    const guarded = createGuardedFetch({ allowLoopback: true });

    const result = await run(mcp.url, "streamable-http", {
      fetch: (url, init) =>
        url.includes("/.well-known/oauth-protected-resource")
          ? Promise.resolve(
              new Response(null, {
                status: 302,
                headers: { location: "http://169.254.169.254/" },
              }),
            )
          : guarded(url, init),
    });

    expect(result).toEqual({ ok: false, code: "mcp_oauth_discovery_failed" });
  });

  it("answers that the authorization server cannot be reached when nothing listens", async () => {
    const { mcp, as } = await setup();
    await as.close();

    const result = await run(mcp.url);

    expect(result).toEqual({ ok: false, code: "mcp_oauth_unreachable" });
  });

  it("reads the resource_metadata and the scope of a WWW-Authenticate challenge", () => {
    expect(
      parseChallenge(
        'Bearer realm="x", resource_metadata="https://a.example/.well-known/oauth-protected-resource", scope="a b", error="invalid_token"',
      ),
    ).toEqual({
      resourceMetadata:
        "https://a.example/.well-known/oauth-protected-resource",
      scope: "a b",
    });
    expect(parseChallenge('Basic realm="x"')).toEqual({
      resourceMetadata: null,
      scope: null,
    });
    expect(parseChallenge(null)).toEqual({
      resourceMetadata: null,
      scope: null,
    });
  });
});

describe("the canonical resource of an address with a query (#1122)", () => {
  // #1122-T02
  it("leaves the query of the server's address out, and still refuses a fragment", () => {
    expect(
      canonicalResource("https://MCP.example.com/mcp/?connection=abc-123"),
    ).toBe("https://mcp.example.com/mcp");
    expect(canonicalResource("https://mcp.example.com/mcp#x")).toBeNull();
  });
});
