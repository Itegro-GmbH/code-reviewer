// SPDX-License-Identifier: LicenseRef-Proprietary

// What the page and the API know of the OAuth connection of an MCP server (#1051): its state and where it came from, never a token, a secret or
// an address. No server-only import: the page's components import the type.
import type {
  McpOAuthClientSource,
  McpOAuthStatus,
  StoredMcpOAuth,
} from "../../db/repositories/mcp-oauth-repository.ts";

export type McpOAuthView = {
  /** `unconnected` until somebody connected the server, `connected`, or `broken` (the authorization server ended the grant: connect again). */
  status: McpOAuthStatus;
  /** Why it is broken (a code of `errors.ts`); null unless it is. */
  errorCode: string | null;
  /** Where the OAuth client comes from; null until the first connection (the registration happens then) when none was entered. */
  clientSource: McpOAuthClientSource | null;
  /** The id of a client an Owner or Admin entered (it is not a secret); null otherwise. */
  clientId: string | null;
  /** Whether a client secret is stored (its value never leaves the server). */
  hasClientSecret: boolean;
  /** The scopes the authorization server granted. */
  scopes: string[];
  /** When the connection was made or last renewed; null unless connected. */
  connectedAt: string | null;
};

export function toOAuthView(stored: StoredMcpOAuth | undefined): McpOAuthView {
  if (stored === undefined)
    return {
      status: "unconnected",
      errorCode: null,
      clientSource: null,
      clientId: null,
      hasClientSecret: false,
      scopes: [],
      connectedAt: null,
    };
  return {
    status: stored.status,
    errorCode: stored.errorCode,
    clientSource: stored.clientSource,
    clientId: stored.clientSource === "manual" ? stored.clientId : null,
    hasClientSecret: stored.clientSource === "manual" && stored.hasClientSecret,
    scopes: stored.scopes,
    connectedAt: stored.status === "connected" ? stored.updatedAt : null,
  };
}
