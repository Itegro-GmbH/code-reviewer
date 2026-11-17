// SPDX-License-Identifier: LicenseRef-Proprietary

// "Connect" of an MCP server of the kind `oauth` (#1051, epic #1049): the authorization code flow with PKCE of the MCP authorization specification.
//
// 1. `startConnect` (an Owner or Admin): discovery (`discovery.ts`), the OAuth client (one an Owner or Admin entered, or the one registered
//    dynamically the first time, `registration.ts`), what was found and the client kept in the connection's row, a signed state (`mcp-connect`: the
//    workspace, the person, a single-use nonce, 10 minutes, bound to the browser session; it keeps the PKCE verifier and names the server and its
//    REVISION) and the address of the consent page.
// 2. The authorization server sends the browser to `<public URL>/api/mcp/oauth/callback?code&state`. `completeCallback` uses the state up first
//    (a wrong, used, expired or foreign state refuses at once and nothing is exchanged), checks the person is still an Owner or Admin, that the
//    server is still at the revision the flow started for (an edit in between ends the flow: the address may be another one now), that `iss`
//    (RFC 9207) is the issuer that was discovered, exchanges the code with the verifier and the `resource`, and seals the pair.
//
// Tokens are sealed in the connection's row (`tokens.ts`) and never leave the server: no answer, page, state, log line or error holds one. A
// state never carries an address; where the browser lands is a fixed page (`http.ts`). The endpoints the callback uses are the ones kept at the
// start, so a second discovery cannot move the flow somewhere else.
import "server-only";
import type { Kysely } from "kysely";
import { createMcpOAuthRepository } from "../../db/repositories/mcp-oauth-repository.ts";
import type { McpOAuthClient } from "../../db/repositories/mcp-oauth-repository.ts";
import { createMcpServersRepository } from "../../db/repositories/mcp-servers-repository.ts";
import type { RateLimitsRepository } from "../../db/repositories/rate-limits-repository.ts";
import { createWorkspacesRepository } from "../../db/repositories/workspaces-repository.ts";
import type { Database } from "../../db/schema.ts";
import type { SignedStates } from "../../signed-state/state.ts";
import { can } from "../../workspaces/permissions.ts";
import { buildAuthorizationUrl } from "./authorization-url.ts";
import { mcpOAuthCallbackUrl } from "./callback-url.ts";
import { discoverOAuth } from "./discovery.ts";
import type { OAuthHttp } from "./endpoint-http.ts";
import type { McpOAuthFailureCode, McpOAuthResultCode } from "./errors.ts";
import { createPkce } from "./pkce.ts";
import { hitMcpOAuthLimit } from "./rate-limits.ts";
import { registerClient } from "./registration.ts";
import { exchangeCode, type OAuthClientAuth } from "./token-endpoint.ts";
import {
  openOAuthClientSecret,
  sealOAuthClientSecret,
  sealOAuthTokens,
} from "./tokens.ts";

export type McpOAuthActor = { id: string; sessionId: string };

export type StartConnectFailure =
  | McpOAuthFailureCode
  | "forbidden"
  | "mcp_server_not_found"
  | "mcp_server_changed"
  | "rate_limited"
  | "unavailable";

export type StartConnectResult =
  | { ok: true; url: string }
  | { ok: false; error: StartConnectFailure; retryAfterSeconds?: number };

export type McpOAuthCallbackResult = {
  /** The workspace the browser goes back to; null when the state could not name one the person administers. */
  workspaceId: string | null;
  /** The server that was connected, when the state named one. */
  serverId: string | null;
  code: McpOAuthResultCode;
};

export type McpOAuthService = {
  startConnect(
    actor: McpOAuthActor,
    workspaceId: string,
    serverId: string,
  ): Promise<StartConnectResult>;
  completeCallback(
    actor: McpOAuthActor,
    query: { code: unknown; state: unknown; error: unknown; iss: unknown },
  ): Promise<McpOAuthCallbackResult>;
};

export type McpOAuthServiceOptions = {
  db: Kysely<Database>;
  signedStates: SignedStates;
  rateLimits: RateLimitsRepository;
  /** The guarded fetch and the test flag (`endpoint-http.ts`). */
  http: OAuthHttp;
  /** The configured public address of the app: the callback address is made from it, never from a header. */
  publicUrl: string;
  /** The master key (`APP_SECRET`). */
  appSecret: string;
  /** The name an authorization server shows on its consent page: the product's name, from its identity. */
  clientName: string;
  now?: () => Date;
  log?: (line: string) => void;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CODE_MAX_LENGTH = 2048;

export function createMcpOAuthService({
  db,
  signedStates,
  rateLimits,
  http,
  publicUrl,
  appSecret,
  clientName,
  now = () => new Date(),
  log = (line) => console.error(line),
}: McpOAuthServiceOptions): McpOAuthService {
  const workspaces = createWorkspacesRepository(db, now);
  const redirectUri = mcpOAuthCallbackUrl(publicUrl);
  const servers = (workspaceId: string) =>
    createMcpServersRepository(db, workspaceId, now);
  const connections = (workspaceId: string) =>
    createMcpOAuthRepository(db, workspaceId, now);

  /** Whether the person is, now, an Owner or Admin of the workspace (read from the database every time). */
  async function administers(
    userId: string,
    workspaceId: string,
  ): Promise<boolean> {
    const membership = await workspaces.findMembershipById(userId, workspaceId);
    return membership !== undefined && can(membership.role, "manage_mcp");
  }

  function done(
    workspaceId: string | null,
    serverId: string | null,
    code: McpOAuthResultCode,
  ): McpOAuthCallbackResult {
    if (code !== "connected") log(`[mcp] MCP_OAUTH_REFUSED: ${code}`);
    return { workspaceId, serverId, code };
  }

  return {
    async startConnect(actor, workspaceId, serverId) {
      if (!(await administers(actor.id, workspaceId)))
        return { ok: false, error: "forbidden" };
      const server = await servers(workspaceId).get(serverId);
      if (server === undefined)
        return { ok: false, error: "mcp_server_not_found" };
      if (server.authKind !== "oauth")
        return { ok: false, error: "mcp_oauth_not_oauth" };
      const limit = await hitMcpOAuthLimit(
        rateLimits,
        "start",
        actor.id,
        now(),
      );
      if (!limit.allowed)
        return {
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: limit.retryAfterSeconds,
        };

      const found = await discoverOAuth(
        {
          url: server.url,
          transport: server.transport === "sse" ? "sse" : "streamable-http",
        },
        http,
      );
      if (!found.ok) return { ok: false, error: found.code };
      const { discovery } = found;

      // The client: the one an Owner or Admin entered, else the one registered for this issuer and callback, else a new registration.
      const rows = connections(workspaceId);
      const existing = await rows.readSecrets(serverId);
      let client: McpOAuthClient | undefined;
      let auth: OAuthClientAuth;
      const stored = existing?.oauth;
      if (stored?.clientSource === "manual" && stored.clientId !== null) {
        let secret: string | null = null;
        if (existing?.clientSecret != null) {
          secret = openOAuthClientSecret(
            appSecret,
            serverId,
            existing.clientSecret,
          );
          if (secret === null) {
            log(
              `[mcp] MCP_OAUTH_CLIENT_UNREADABLE: check APP_SECRET (server ${serverId}).`,
            );
            return { ok: false, error: "unavailable" };
          }
        }
        // The method follows what the authorization server supports; a client without a secret is a public client.
        const method =
          secret === null
            ? "none"
            : discovery.authMethods.includes("client_secret_basic") ||
                !discovery.authMethods.includes("client_secret_post")
              ? "client_secret_basic"
              : "client_secret_post";
        auth = { clientId: stored.clientId, clientSecret: secret, method };
        client = {
          source: "manual",
          clientId: stored.clientId,
          authMethod: method,
          sealedSecret: existing?.clientSecret ?? null,
        };
      } else if (
        stored?.clientSource === "dynamic" &&
        stored.clientId !== null &&
        stored.clientAuthMethod !== null &&
        stored.registeredIssuer === discovery.issuer &&
        stored.registeredRedirectUri === redirectUri
      ) {
        let secret: string | null = null;
        if (existing?.clientSecret != null) {
          secret = openOAuthClientSecret(
            appSecret,
            serverId,
            existing.clientSecret,
          );
          if (secret === null) {
            log(
              `[mcp] MCP_OAUTH_CLIENT_UNREADABLE: check APP_SECRET (server ${serverId}).`,
            );
            return { ok: false, error: "unavailable" };
          }
        }
        auth = {
          clientId: stored.clientId,
          clientSecret: secret,
          method: stored.clientAuthMethod,
        };
      } else {
        const registered = await registerClient(
          discovery,
          { redirectUri, clientName },
          http,
        );
        if (!registered.ok) return { ok: false, error: registered.code };
        auth = {
          clientId: registered.client.clientId,
          clientSecret: registered.client.clientSecret,
          method: registered.client.authMethod,
        };
        client = {
          source: "dynamic",
          clientId: registered.client.clientId,
          authMethod: registered.client.authMethod,
          sealedSecret:
            registered.client.clientSecret === null
              ? null
              : sealOAuthClientSecret(
                  appSecret,
                  serverId,
                  registered.client.clientSecret,
                ),
          registeredIssuer: discovery.issuer,
          registeredRedirectUri: redirectUri,
        };
      }

      const kept = await rows.saveStart(serverId, server.revision, {
        discovery,
        ...(client === undefined ? {} : { client }),
      });
      if (!kept) return { ok: false, error: "mcp_server_changed" };

      const pkce = createPkce();
      const state = await signedStates.issue({
        purpose: "mcp-connect",
        userId: actor.id,
        sessionId: actor.sessionId,
        workspaceId,
        codeVerifier: pkce.verifier,
        data: { serverId, revision: server.revision },
      });
      return {
        ok: true,
        url: buildAuthorizationUrl(discovery, {
          clientId: auth.clientId,
          redirectUri,
          state,
          challenge: pkce.challenge,
        }),
      };
    },

    async completeCallback(actor, query) {
      if (typeof query.state !== "string" || query.state === "")
        return done(null, null, "state_invalid");
      // The state is used up first: a forged, used, expired or foreign one ends here, before anything is asked of the authorization server.
      const consumed = await signedStates.consume({
        purpose: "mcp-connect",
        value: query.state,
        userId: actor.id,
        sessionId: actor.sessionId,
      });
      if (
        !consumed.ok ||
        consumed.workspaceId === null ||
        consumed.codeVerifier === null ||
        !isObject(consumed.data) ||
        typeof consumed.data.serverId !== "string" ||
        typeof consumed.data.revision !== "number"
      )
        return done(null, null, "state_invalid");
      const { workspaceId, codeVerifier } = consumed;
      const { serverId, revision } = consumed.data as {
        serverId: string;
        revision: number;
      };
      if (!(await administers(actor.id, workspaceId)))
        return done(null, null, "workspace_role_required");
      const server = await servers(workspaceId).get(serverId);
      if (server === undefined)
        return done(workspaceId, null, "mcp_server_not_found");
      if (server.revision !== revision || server.authKind !== "oauth")
        return done(workspaceId, serverId, "mcp_server_changed");
      const fail = (code: McpOAuthResultCode) =>
        done(workspaceId, serverId, code);

      if (query.error !== undefined)
        return fail(
          query.error === "access_denied"
            ? "access_denied"
            : "mcp_oauth_authorization_refused",
        );
      if (
        typeof query.code !== "string" ||
        query.code === "" ||
        query.code.length > CODE_MAX_LENGTH
      )
        return fail("mcp_oauth_authorization_refused");
      const rows = connections(workspaceId);
      const secrets = await rows.readSecrets(serverId);
      const discovery = secrets?.oauth.discovery ?? null;
      const clientId = secrets?.oauth.clientId ?? null;
      const method = secrets?.oauth.clientAuthMethod ?? null;
      if (
        secrets === undefined ||
        discovery === null ||
        clientId === null ||
        method === null
      )
        return fail("mcp_server_changed");
      // RFC 9207: an authorization server that says it sends `iss` must, and the one it sends is the issuer that was discovered, so a
      // response from another authorization server (a mix-up) is not accepted. A wrong `iss` is refused whether it was announced or not.
      const iss = query.iss;
      if (
        (iss === undefined && discovery.issParameter) ||
        (iss !== undefined &&
          (typeof iss !== "string" ||
            iss.replace(/\/+$/, "") !== discovery.issuer))
      )
        return fail("mcp_oauth_authorization_refused");
      const limit = await hitMcpOAuthLimit(
        rateLimits,
        "callback",
        actor.id,
        now(),
      );
      if (!limit.allowed) return fail("rate_limited");

      let clientSecret: string | null = null;
      if (secrets.clientSecret !== null) {
        clientSecret = openOAuthClientSecret(
          appSecret,
          serverId,
          secrets.clientSecret,
        );
        if (clientSecret === null) {
          log(
            `[mcp] MCP_OAUTH_CLIENT_UNREADABLE: check APP_SECRET (server ${serverId}).`,
          );
          return fail("unavailable");
        }
      }
      const token = await exchangeCode(
        discovery,
        { clientId, clientSecret, method },
        { code: query.code, redirectUri, verifier: codeVerifier },
        http,
      );
      if (!token.ok) {
        if (token.kind === "client")
          log(
            `[mcp] MCP_OAUTH_CLIENT_REFUSED: the authorization server does not accept the OAuth client (check the client id and secret, server ${serverId}).`,
          );
        return fail(
          token.kind === "refused"
            ? "mcp_oauth_authorization_refused"
            : token.kind === "client"
              ? "mcp_oauth_client_refused"
              : token.kind === "address_refused"
                ? "mcp_oauth_address_refused"
                : "mcp_oauth_unreachable",
        );
      }
      const { grant } = token;
      const saved = await rows.saveConnection(serverId, revision, {
        sealedTokens: sealOAuthTokens(appSecret, serverId, {
          accessToken: grant.accessToken,
          refreshToken: grant.refreshToken,
        }),
        accessExpiresAt: new Date(
          now().getTime() + grant.expiresInSeconds * 1000,
        ),
        scopes: grant.scopes ?? discovery.scopes,
        connectedBy: actor.id,
      });
      return saved
        ? done(workspaceId, serverId, "connected")
        : fail("mcp_server_changed");
    },
  };
}
