// SPDX-License-Identifier: LicenseRef-Proprietary

// A fake OAuth 2.1 authorization server (loopback only, in memory) for the tests of the OAuth connection of MCP servers (#1051, epic #1049).
// It speaks what the MCP authorization spec needs of a server, in the shapes of the RFCs, so the production client runs unchanged:
//   GET  <issuer path>/.well-known/oauth-authorization-server   RFC 8414 metadata (or OpenID Connect discovery: `metadata: "openid"`)
//   POST /register                                              RFC 7591 dynamic client registration (`registration: false` leaves it out)
//   GET  /authorize                                             the consent page: it answers a redirect to the client's `redirect_uri` with `code` and
//                                                               `state` (or `error=access_denied`), as the person's click would; `setConsent` chooses
//   POST /token                                                 `authorization_code` (PKCE S256 verified, `redirect_uri` and `resource` recorded) and
//                                                               `refresh_token` (the refresh token rotates: a used one is refused with `invalid_grant`)
// A test can script the next answer of the token endpoint (`script`), revoke the refresh tokens, and read what the endpoints were asked
// (`requests`, never a token or a secret: only names and the parameters that are not secret). `isValidAccessToken` is what an MCP server
// that trusts this authorization server calls (`startMcpFake({ oauth })`). Dummy values only; started by a test through `startOAuthFake`.
import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { keepConnectionsOpen } from "../keep-alive.ts";
import { isLoopbackHostname } from "../stripe/loopback.ts";

export type OAuthFakeOptions = {
  host?: string;
  /** A path under the origin the issuer has (`/tenant`): the metadata is then served at the RFC 8414 / OIDC places for a path. */
  issuerPath?: string;
  /** Where the metadata is: RFC 8414 (default), OpenID Connect discovery inserted before the path, or appended to it. */
  metadata?: "oauth" | "openid" | "openid-appended";
  /** Whether a registration endpoint is advertised and served; default true. */
  registration?: boolean;
  /** What dynamic registration answers: a public client (default) or a client with a secret. */
  registeredClient?: "public" | "confidential";
  /** The `code_challenge_methods_supported` the metadata lists; default `["S256"]`. */
  pkceMethods?: string[];
  /** `authorization_response_iss_parameter_supported` (RFC 9207), and the `iss` of the redirect. */
  issParameter?: boolean;
  /** The `iss` the redirect carries when `issParameter` is on (to test a mismatch); default the issuer. */
  redirectIssuer?: string;
  accessTokenTtlSeconds?: number;
  /** Whether a refresh token is issued; default true. */
  refreshTokens?: boolean;
  /** The `issuer` the metadata names, when it must differ from where it was served (to test a mismatch). */
  claimedIssuer?: string;
};

export type OAuthScript = { status: number; body: Record<string, unknown> };

/** What an endpoint was asked; no token and no secret is ever recorded, only whether one was sent. */
export type RecordedOAuthRequest = {
  method: string;
  path: string;
  /** The `grant_type` of a token request. */
  grantType: string | null;
  clientId: string | null;
  /** How the client authenticated at the token endpoint. */
  clientAuth: "none" | "basic" | "post";
  /** The `resource` parameter (RFC 8707) of an authorization or token request. */
  resource: string | null;
  redirectUri: string | null;
  scope: string | null;
};

export type OAuthFake = {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** What the authorization server calls itself: the origin plus its path. */
  issuer: string;
  /** The authorization endpoint (what the browser is sent to). */
  authorizationEndpoint: string;
  /** A client entered by hand (the admin's fallback): it needs no registration. */
  addClient(client: {
    clientId: string;
    clientSecret?: string;
    redirectUris?: string[];
  }): void;
  /** What the next visits of the consent page do: approve (default) or deny. */
  setConsent(decision: "approve" | "deny"): void;
  /** The next token request of `kind` gets this answer instead of the normal one (queued, one each). */
  script(kind: "code" | "refresh", answer: OAuthScript): void;
  /** What the MCP server asks: whether this access token is one this server issued and has not ended. */
  isValidAccessToken(token: string): boolean;
  /** Ends every access token (the server forgets them; a call with one is 401). */
  endAccessTokens(): void;
  /** Revokes every refresh token: the next refresh is answered `invalid_grant`. */
  revokeRefreshTokens(): void;
  /** The tokens last issued (dummy values; a test looks for them nowhere else). */
  lastIssued(): { accessToken: string; refreshToken: string | null } | null;
  /** How many clients were registered dynamically. */
  registrations(): number;
  requests(): readonly RecordedOAuthRequest[];
  close(): Promise<void>;
};

type Client = {
  secret: string | null;
  redirectUris: string[] | null;
};

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...extra,
  });
  response.end(JSON.stringify(body));
}

export async function startOAuthFake(
  options: OAuthFakeOptions = {},
): Promise<OAuthFake> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHostname(host))
    throw new Error(
      `The fake authorization server only listens on a loopback address, not ${host}.`,
    );
  const issuerPath = options.issuerPath ?? "";
  const registration = options.registration ?? true;
  const ttl = options.accessTokenTtlSeconds ?? 3600;
  const clients = new Map<string, Client>();
  const codes = new Map<
    string,
    {
      clientId: string;
      challenge: string;
      redirectUri: string;
      resource: string | null;
    }
  >();
  const accessTokens = new Set<string>();
  const refreshTokens = new Map<string, string>();
  const scripted: Record<"code" | "refresh", OAuthScript[]> = {
    code: [],
    refresh: [],
  };
  const recorded: RecordedOAuthRequest[] = [];
  let decision: "approve" | "deny" = "approve";
  let registered = 0;
  let issued: { accessToken: string; refreshToken: string | null } | null =
    null;
  let origin = "";
  const issuer = () => `${origin}${issuerPath}`;

  function metadataPaths(): string[] {
    const mode = options.metadata ?? "oauth";
    if (mode === "oauth")
      return [`/.well-known/oauth-authorization-server${issuerPath}`];
    if (mode === "openid")
      return [`/.well-known/openid-configuration${issuerPath}`];
    return [`${issuerPath}/.well-known/openid-configuration`];
  }

  function metadata() {
    return {
      issuer: options.claimedIssuer ?? issuer(),
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      ...(registration ? { registration_endpoint: `${origin}/register` } : {}),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_basic",
        "client_secret_post",
      ],
      code_challenge_methods_supported: options.pkceMethods ?? ["S256"],
      ...(options.issParameter === true
        ? { authorization_response_iss_parameter_supported: true }
        : {}),
    };
  }

  function issue(clientId: string): {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
  } {
    const accessToken = `at-${base64url(randomBytes(18))}`;
    accessTokens.add(accessToken);
    const refreshToken =
      options.refreshTokens === false
        ? null
        : `rt-${base64url(randomBytes(18))}`;
    if (refreshToken !== null) refreshTokens.set(refreshToken, clientId);
    issued = { accessToken, refreshToken };
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ttl,
      ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
    };
  }

  /** The client of a token request: from the Basic header or the body; null when it is unknown or its secret is wrong. */
  function authenticate(
    request: IncomingMessage,
    form: URLSearchParams,
  ): {
    clientId: string;
    auth: "none" | "basic" | "post";
    client: Client;
  } | null {
    let clientId = form.get("client_id");
    let secret = form.get("client_secret");
    let auth: "none" | "basic" | "post" = secret === null ? "none" : "post";
    const header = request.headers.authorization;
    if (typeof header === "string" && header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      clientId = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
      auth = "basic";
    }
    if (clientId === null) return null;
    const client = clients.get(clientId);
    if (client === undefined) return null;
    if (client.secret !== null && client.secret !== secret) return null;
    return { clientId, auth, client };
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake.test");
    const method = request.method ?? "GET";
    const body = method === "POST" ? await readBody(request) : "";
    const record = (
      extra: Partial<RecordedOAuthRequest> = {},
    ): RecordedOAuthRequest => {
      const entry: RecordedOAuthRequest = {
        method,
        path: url.pathname,
        grantType: null,
        clientId: null,
        clientAuth: "none",
        resource: null,
        redirectUri: null,
        scope: null,
        ...extra,
      };
      recorded.push(entry);
      return entry;
    };

    if (method === "GET" && metadataPaths().includes(url.pathname)) {
      record();
      json(response, 200, metadata());
      return;
    }

    if (method === "POST" && registration && url.pathname === "/register") {
      record();
      let document: Record<string, unknown> = {};
      try {
        document = JSON.parse(body) as Record<string, unknown>;
      } catch {
        json(response, 400, { error: "invalid_client_metadata" });
        return;
      }
      const redirectUris = Array.isArray(document.redirect_uris)
        ? (document.redirect_uris as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      if (redirectUris.length === 0) {
        json(response, 400, { error: "invalid_redirect_uri" });
        return;
      }
      registered += 1;
      const clientId = `client-${String(registered)}-${base64url(randomBytes(6))}`;
      const confidential = options.registeredClient === "confidential";
      const secret = confidential
        ? `secret-${base64url(randomBytes(12))}`
        : null;
      clients.set(clientId, { secret, redirectUris });
      json(response, 201, {
        client_id: clientId,
        ...(secret === null
          ? {}
          : { client_secret: secret, client_secret_expires_at: 0 }),
        redirect_uris: redirectUris,
        token_endpoint_auth_method:
          secret === null ? "none" : "client_secret_basic",
      });
      return;
    }

    if (method === "GET" && url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      record({
        clientId,
        resource: url.searchParams.get("resource"),
        redirectUri,
        scope: url.searchParams.get("scope"),
      });
      const client = clients.get(clientId);
      if (
        client === undefined ||
        (client.redirectUris !== null &&
          !client.redirectUris.includes(redirectUri))
      ) {
        json(response, 400, { error: "invalid_client" });
        return;
      }
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      if (
        url.searchParams.get("response_type") !== "code" ||
        challenge === null ||
        url.searchParams.get("code_challenge_method") !== "S256"
      ) {
        json(response, 400, { error: "invalid_request" });
        return;
      }
      const target = new URL(redirectUri);
      if (state !== null) target.searchParams.set("state", state);
      if (options.issParameter === true)
        target.searchParams.set("iss", options.redirectIssuer ?? issuer());
      if (decision === "deny")
        target.searchParams.set("error", "access_denied");
      else {
        const code = `code-${base64url(randomBytes(12))}`;
        codes.set(code, {
          clientId,
          challenge,
          redirectUri,
          resource: url.searchParams.get("resource"),
        });
        target.searchParams.set("code", code);
      }
      response.writeHead(302, { location: target.toString() });
      response.end();
      return;
    }

    if (method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(body);
      const grantType = form.get("grant_type");
      const caller = authenticate(request, form);
      record({
        grantType,
        clientId: caller?.clientId ?? form.get("client_id"),
        clientAuth: caller?.auth ?? "none",
        resource: form.get("resource"),
        redirectUri: form.get("redirect_uri"),
      });
      const kind = grantType === "refresh_token" ? "refresh" : "code";
      const answer = scripted[kind].shift();
      if (answer !== undefined) {
        json(response, answer.status, answer.body);
        return;
      }
      if (caller === null) {
        json(response, 401, { error: "invalid_client" });
        return;
      }
      if (grantType === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = base64url(
          createHash("sha256").update(verifier).digest(),
        );
        if (
          code === undefined ||
          code.clientId !== caller.clientId ||
          code.redirectUri !== form.get("redirect_uri") ||
          code.challenge !== challenge
        ) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        json(response, 200, issue(caller.clientId));
        return;
      }
      if (grantType === "refresh_token") {
        const token = form.get("refresh_token") ?? "";
        if (refreshTokens.get(token) !== caller.clientId) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        refreshTokens.delete(token);
        json(response, 200, issue(caller.clientId));
        return;
      }
      json(response, 400, { error: "unsupported_grant_type" });
      return;
    }

    json(response, 404, { error: "not_found" });
  }

  const server: Server = keepConnectionsOpen(
    createServer((request, response) => {
      void handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    }),
  );
  await new Promise<void>((resolve) => {
    server.listen(0, host, resolve);
  });
  origin = `http://${host}:${String((server.address() as AddressInfo).port)}`;

  return {
    origin,
    issuer: issuer(),
    authorizationEndpoint: `${origin}/authorize`,
    addClient({ clientId, clientSecret, redirectUris }) {
      clients.set(clientId, {
        secret: clientSecret ?? null,
        redirectUris: redirectUris ?? null,
      });
    },
    setConsent(next) {
      decision = next;
    },
    script(kind, answer) {
      scripted[kind].push(answer);
    },
    isValidAccessToken: (token) => accessTokens.has(token),
    endAccessTokens() {
      accessTokens.clear();
    },
    revokeRefreshTokens() {
      refreshTokens.clear();
    },
    lastIssued: () => issued,
    registrations: () => registered,
    requests: () => recorded,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
