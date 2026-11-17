// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable codes of the OAuth connection of an MCP server (#1051, epic #1049). A page translates a code to copy (../ui/messages.ts), never the
// other way round, and no code carries a token, a secret, an address or a body. Four sets:
//
// - why discovery, registration or a token call did not work (`MCP_OAUTH_FAILURE_CODES`): the person who starts "Connect" is told, the server is unchanged;
// - how the browser's way back ended (`MCP_OAUTH_RESULT_CODES`): shown once on the MCP page, from our own list, never from the request;
// - why a server cannot give out its token (`MCP_OAUTH_USE_CODES`): the connection test and, later, the proxy at the sandbox's door (#1053);
// - why a connection is broken (`MCP_OAUTH_BROKEN_CODES`): stored on the row; mended by connecting again.

/** Why starting a connection, or a call to the authorization server, did not work. */
export const MCP_OAUTH_FAILURE_CODES = [
  /** The server is not of the kind `oauth`. */
  "mcp_oauth_not_oauth",
  /** The server's 401 and well-known documents do not lead to an authorization server this server can use (or an answer is not what the RFCs say). */
  "mcp_oauth_discovery_failed",
  /** An address in the discovery (the metadata, the authorization server, an endpoint) is private, plain http or otherwise not allowed. */
  "mcp_oauth_address_refused",
  /** The authorization server does not list the code challenge method S256: a client must not go on without PKCE. */
  "mcp_oauth_pkce_unsupported",
  /** The authorization server offers no dynamic registration and no client id was entered: an Owner or Admin has to enter one. */
  "mcp_oauth_client_required",
  /** The authorization server refused the dynamic registration, or answered something that is no registration. */
  "mcp_oauth_registration_failed",
  /** The authorization server could not be reached or did not answer in time. */
  "mcp_oauth_unreachable",
  /** The client an Owner or Admin entered is for another authorization server than the one this server's discovery found: its secret is not sent there. */
  "mcp_oauth_issuer_mismatch",
] as const;
export type McpOAuthFailureCode = (typeof MCP_OAUTH_FAILURE_CODES)[number];

/** How the way back from the authorization server ended; the page shows it once. */
export const MCP_OAUTH_RESULT_CODES = [
  "connected",
  /** The state is wrong, used, expired, from another session, or for another person. Nothing was asked of the authorization server. */
  "state_invalid",
  /** The person said no at the consent page. */
  "access_denied",
  /** The authorization server answered with another error, or without a code, or its `iss` is not the issuer that was discovered. */
  "mcp_oauth_authorization_refused",
  /** The authorization server did not accept the OAuth client (the id or secret an Owner or Admin entered, or the registration). */
  "mcp_oauth_client_refused",
  "workspace_role_required",
  "mcp_server_not_found",
  /** The server was changed while the person was at the consent page. */
  "mcp_server_changed",
  "mcp_oauth_unreachable",
  "mcp_oauth_address_refused",
  "rate_limited",
  "unavailable",
] as const;
export type McpOAuthResultCode = (typeof MCP_OAUTH_RESULT_CODES)[number];

export function isMcpOAuthResultCode(
  value: unknown,
): value is McpOAuthResultCode {
  return (
    typeof value === "string" &&
    (MCP_OAUTH_RESULT_CODES as readonly string[]).includes(value)
  );
}

/** Why the token of a server cannot be given out. */
export const MCP_OAUTH_USE_CODES = [
  /** Nobody connected the server yet. */
  "mcp_oauth_not_connected",
  /** The authorization server ended the grant (`invalid_grant`): connect again. */
  "mcp_oauth_broken",
  /** A refresh could not be made now (the authorization server is down, the client is wrong, the key cannot open the tokens): nothing is marked, try again. */
  "mcp_oauth_unavailable",
] as const;
export type McpOAuthUseCode = (typeof MCP_OAUTH_USE_CODES)[number];

/** Why a connection is broken. */
export const MCP_OAUTH_BROKEN_CODES = [
  /** The authorization server answered `invalid_grant` to the refresh: the refresh token is revoked, expired or used. */
  "mcp_oauth_refresh_refused",
  /** The access token ended and the grant has no refresh token. */
  "mcp_oauth_expired",
] as const;
export type McpOAuthBrokenCode = (typeof MCP_OAUTH_BROKEN_CODES)[number];
