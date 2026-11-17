// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable codes of the MCP registry (#1050, epic #1049). A page translates a code to copy (ui/messages.ts), never the other way round,
// and no code carries a header value, an address or a response body. Three sets:
//
// - the refusals of a request (`MCP_ERROR_CODES`): nothing was saved, removed or changed;
// - the reasons an address or a header is refused (`MCP_INPUT_CODES`, a part of the refusals): the form shows them at the field;
// - how a connection test ended (`MCP_TEST_ERROR_CODES`): stored on the row and shown on the page; the request itself is a success.

/** Why a value of the form is refused. Each belongs to one field of the form (`MCP_INPUT_FIELD`). */
export const MCP_INPUT_CODES = [
  /** The name is empty, too long or has characters other than letters, digits, space, `_`, `-` and `.`. */
  "mcp_name_invalid",
  /** The workspace has a server of this name already (case ignored). */
  "mcp_name_taken",
  /** The transport is not `streamable-http` or `sse`. */
  "mcp_transport_invalid",
  /** The address is no http(s) address, is too long, or has a fragment. */
  "mcp_url_invalid",
  /** The address is plain http (only https is allowed). */
  "mcp_url_not_https",
  /** The address holds a user name or a password. */
  "mcp_url_credentials",
  /** The address has a query string: a key belongs in a header. */
  "mcp_url_query",
  /** The address names this machine or a private, link-local or reserved place, or the metadata service. */
  "mcp_url_private",
  /** The authentication is not `none` or `header`. */
  "mcp_auth_invalid",
  /** `oauth` is reserved (#1051): not available yet. */
  "mcp_auth_oauth_unavailable",
  /** Authentication `header` without a header, more headers than allowed, or a list that is not a list of name and value. */
  "mcp_headers_invalid",
  /** A header name is not a valid HTTP header name, is too long, or appears twice. */
  "mcp_header_name_invalid",
  /** A header name the client sets itself (`Host`, `Content-Type`, `Accept`, `Mcp-Session-Id`, ...). */
  "mcp_header_name_forbidden",
  /** A header value is empty, too long, or holds a line break or another control character. */
  "mcp_header_value_invalid",
  /** Editing: a header kept without a new value that the server does not have. */
  "mcp_header_unknown",
] as const;
export type McpInputCode = (typeof MCP_INPUT_CODES)[number];

export const MCP_ERROR_CODES = [
  ...MCP_INPUT_CODES,
  /** The signed in person may not manage MCP servers (an Owner or Admin may). */
  "forbidden",
  /** The server is not one of this workspace. */
  "mcp_server_not_found",
  /** A lane still uses the server; the answer names the lanes. */
  "mcp_server_in_use",
  /** The workspace holds the most servers it may. */
  "mcp_limit_reached",
  /** The server was changed while the request ran: reload and try again. */
  "mcp_server_changed",
  "rate_limited",
  /** The database could not be read or written; nothing was done. */
  "unavailable",
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export const MCP_ERROR_STATUS: Record<McpErrorCode, number> = {
  mcp_name_invalid: 422,
  mcp_name_taken: 409,
  mcp_transport_invalid: 422,
  mcp_url_invalid: 422,
  mcp_url_not_https: 422,
  mcp_url_credentials: 422,
  mcp_url_query: 422,
  mcp_url_private: 422,
  mcp_auth_invalid: 422,
  mcp_auth_oauth_unavailable: 422,
  mcp_headers_invalid: 422,
  mcp_header_name_invalid: 422,
  mcp_header_name_forbidden: 422,
  mcp_header_value_invalid: 422,
  mcp_header_unknown: 422,
  forbidden: 403,
  mcp_server_not_found: 404,
  mcp_server_in_use: 409,
  mcp_limit_reached: 409,
  mcp_server_changed: 409,
  rate_limited: 429,
  unavailable: 503,
};

/** The field of the form an input code belongs to. */
export const MCP_INPUT_FIELD: Record<
  McpInputCode,
  "name" | "transport" | "url" | "auth" | "headers"
> = {
  mcp_name_invalid: "name",
  mcp_name_taken: "name",
  mcp_transport_invalid: "transport",
  mcp_url_invalid: "url",
  mcp_url_not_https: "url",
  mcp_url_credentials: "url",
  mcp_url_query: "url",
  mcp_url_private: "url",
  mcp_auth_invalid: "auth",
  mcp_auth_oauth_unavailable: "auth",
  mcp_headers_invalid: "headers",
  mcp_header_name_invalid: "headers",
  mcp_header_name_forbidden: "headers",
  mcp_header_value_invalid: "headers",
  mcp_header_unknown: "headers",
};

/** How a connection test ended when it did not succeed. Stored on the row; never holds an address, a header or a body. */
export const MCP_TEST_ERROR_CODES = [
  /** The server could not be reached (no connection, a failed TLS handshake, a name that does not resolve). */
  "mcp_test_unreachable",
  /** The server did not answer in time. */
  "mcp_test_timeout",
  /** The address, or one it was redirected to, resolves to or names a private, link-local, loopback or reserved place. */
  "mcp_test_address_refused",
  /** The server redirected to an address that is not allowed, or too often. */
  "mcp_test_redirect_refused",
  /** 401 or 403: the server wants other credentials. */
  "mcp_test_unauthorized",
  /** The server answered another status (404, 405, 5xx, ...). */
  "mcp_test_http_error",
  /** The answer is not what an MCP server of this transport says (not JSON-RPC, not an event stream, no endpoint event). */
  "mcp_test_protocol_error",
  /** The server answered a JSON-RPC error to `initialize` or `tools/list`. */
  "mcp_test_rejected",
  /** The answer, or the list of tools, is larger than the test reads. */
  "mcp_test_too_large",
  /** The stored headers cannot be read with the key of this server (a changed APP_SECRET). */
  "mcp_test_credentials_unreadable",
] as const;
export type McpTestErrorCode = (typeof MCP_TEST_ERROR_CODES)[number];

export function isMcpErrorCode(value: unknown): value is McpErrorCode {
  return (
    typeof value === "string" &&
    (MCP_ERROR_CODES as readonly string[]).includes(value)
  );
}
