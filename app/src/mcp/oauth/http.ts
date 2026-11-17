// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the routes of the OAuth connection of an MCP server (#1051), with their collaborators passed in so the route files only
// wire the real ones and tests wire the real service over a test database:
//
//   POST /api/w/:workspace/mcp/servers/:id/connect   starts "Connect" (an Owner or Admin) and answers the address of the consent page
//   GET  /api/mcp/oauth/callback                     ?code&state (or ?error&state): where the authorization server sends the browser
//
// Who is asking and in which workspace is settled before the data routes run (src/workspaces/access-runtime.ts); the role is checked here
// once more and the service reads the membership again from the database. The callback is the authorization server's own redirect: it takes its
// facts from the query, and what it does with them is the service's (a signed state, used once, bound to the person and the session).
//
// Where a browser lands is ALWAYS a fixed page chosen here: the MCP page of the workspace the state named, with a code of our own list (and the
// id of the server, which is ours) in the query, or `/` when no workspace can be named. Nothing the authorization server said, other than a
// code of our own list, ends up in an address. Every answer is `Cache-Control: no-store`; the redirects send `Referrer-Policy: no-referrer`, so
// the state and the code in their addresses never travel in a header. No answer holds a token.
import { isCrossSite } from "../../http/request-checks.ts";
import type { WorkspaceAccess } from "../../workspaces/access.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import { can } from "../../workspaces/permissions.ts";
import type { McpOAuthService, StartConnectFailure } from "./service.ts";

/** The MCP page of a workspace: where a flow ends. */
export const MCP_OAUTH_RESULT_PLACE = "/mcp";

const NO_STORE = { "cache-control": "no-store" };

export const MCP_OAUTH_START_STATUS: Record<StartConnectFailure, number> = {
  forbidden: 403,
  mcp_server_not_found: 404,
  mcp_server_changed: 409,
  mcp_oauth_not_oauth: 409,
  mcp_oauth_discovery_failed: 503,
  mcp_oauth_address_refused: 422,
  mcp_oauth_pkce_unsupported: 503,
  mcp_oauth_client_required: 422,
  mcp_oauth_registration_failed: 503,
  mcp_oauth_unreachable: 503,
  mcp_oauth_issuer_mismatch: 422,
  rate_limited: 429,
  unavailable: 503,
};

function refusal(
  code: StartConnectFailure | "cross_site_request" | "UNAUTHENTICATED",
  retryAfterSeconds?: number,
): Response {
  const status =
    code === "cross_site_request"
      ? 403
      : code === "UNAUTHENTICATED"
        ? 401
        : MCP_OAUTH_START_STATUS[code];
  return Response.json(
    { error: code },
    {
      status,
      headers: {
        ...NO_STORE,
        ...(retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(retryAfterSeconds) }),
      },
    },
  );
}

export type McpOAuthRouteDependencies = {
  service: McpOAuthService;
  /** The id of the session of the current request, or null. */
  sessionId: () => Promise<string | null>;
  /** The person and the session of a request (for the callback), or null when there is none. */
  session: (
    request: Request,
  ) => Promise<{ userId: string; sessionId: string } | null>;
  /** The address name of a workspace, or null when there is none. */
  workspaceSlug: (workspaceId: string) => Promise<string | null>;
};

export type McpOAuthRouteHandlers = {
  connect(
    request: Request,
    access: WorkspaceAccess,
    serverId: string,
  ): Promise<Response>;
  callback(request: Request): Promise<Response>;
};

export function createMcpOAuthRouteHandlers(
  deps: McpOAuthRouteDependencies,
): McpOAuthRouteHandlers {
  const { service } = deps;

  function redirectTo(location: string): Response {
    return new Response(null, {
      status: 302,
      headers: { location, "referrer-policy": "no-referrer", ...NO_STORE },
    });
  }

  async function landing(
    workspaceId: string | null,
    serverId: string | null,
    code: string,
  ): Promise<Response> {
    const slug =
      workspaceId === null ? null : await deps.workspaceSlug(workspaceId);
    if (slug === null) return redirectTo("/");
    const query = new URLSearchParams({ mcp: code });
    if (serverId !== null) query.set("server", serverId);
    return redirectTo(
      `${workspacePath(slug, MCP_OAUTH_RESULT_PLACE)}?${query.toString()}`,
    );
  }

  return {
    async connect(request, access, serverId) {
      if (isCrossSite(request)) return refusal("cross_site_request");
      if (!can(access.role, "manage_mcp")) return refusal("forbidden");
      const sessionId = await deps.sessionId();
      if (sessionId === null) return refusal("UNAUTHENTICATED");
      try {
        const result = await service.startConnect(
          { id: access.user.id, sessionId },
          access.workspace.id,
          serverId,
        );
        return result.ok
          ? Response.json(
              {
                ok: true,
                url: result.url,
                issuerHost: result.issuerHost,
                scopes: result.scopes,
              },
              { headers: NO_STORE },
            )
          : refusal(result.error, result.retryAfterSeconds);
      } catch {
        console.error(
          "[mcp] MCP_OAUTH_UNAVAILABLE: the request was not served.",
        );
        return refusal("unavailable");
      }
    },

    async callback(request) {
      const url = new URL(request.url);
      let who: { userId: string; sessionId: string } | null;
      try {
        who = await deps.session(request);
      } catch {
        return Response.redirect(
          new URL("/login?error=sign_in_unavailable", url),
          302,
        );
      }
      // Nobody is signed in here: a flow cannot be completed by somebody else's browser.
      if (who === null)
        return new Response(null, {
          status: 302,
          headers: { location: "/login", ...NO_STORE },
        });
      try {
        const result = await service.completeCallback(
          { id: who.userId, sessionId: who.sessionId },
          {
            code: url.searchParams.get("code") ?? undefined,
            state: url.searchParams.get("state") ?? undefined,
            error: url.searchParams.get("error") ?? undefined,
            iss: url.searchParams.get("iss") ?? undefined,
          },
        );
        return await landing(result.workspaceId, result.serverId, result.code);
      } catch {
        console.error(
          "[mcp] MCP_OAUTH_UNAVAILABLE: the request was not served.",
        );
        return landing(null, null, "unavailable");
      }
    },
  };
}
