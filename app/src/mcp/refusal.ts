// SPDX-License-Identifier: LicenseRef-Proprietary

// What the app answers to the agent's side of the MCP route when it does not call the server at all (#1053): one JSON-RPC-shaped error, so the
// harness's MCP client reads every refusal the way it reads the proxy's own. Stable words; never a value, an address or a body of the server.
// The table of codes, statuses and whether a call may be tried again is in `docs/mcp-runtime.md`.

/** The refusals of the route before the proxy is asked. (The proxy's own codes are `MCP_PROXY_ERROR_CODES`, the credential's `MCP_CREDENTIAL_FAILURES`.) */
export const MCP_ROUTE_REFUSALS = {
  /** The server is not one of the job's step, was removed, does not exist, or the deployment has no MCP runtime: one answer for all. */
  mcp_server_unavailable: 404,
  /** The body is larger than a request may be. */
  mcp_proxy_request_too_large: 413,
  /** The claim made as many calls as it may: no more for this claim, whatever the agent tries. */
  mcp_call_limit_reached: 429,
  /** Too many calls of this job are in flight at the same moment: the same call may be tried again in a moment. */
  mcp_too_many_concurrent_calls: 429,
  /** The credential of the server cannot be opened (a master key that changed, a connection that needs a new sign-in). */
  mcp_credential_broken: 503,
  /** The server needs a kind of credential this deployment has no provider for. */
  mcp_credential_unsupported: 503,
} as const;
export type McpRouteRefusal = keyof typeof MCP_ROUTE_REFUSALS;

export function mcpRefusal(
  code: McpRouteRefusal,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: code },
    }),
    {
      status: MCP_ROUTE_REFUSALS[code],
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...extraHeaders,
      },
    },
  );
}
