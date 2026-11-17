// SPDX-License-Identifier: LicenseRef-Proprietary

// The address of the authorization server's consent page (RFC 6749, 4.1.1) with what the MCP authorization specification requires of a client:
// PKCE with S256 (RFC 7636) and the `resource` parameter (RFC 8707), here the canonical address of the MCP server the token is for.
import type { McpOAuthDiscovery } from "../../db/repositories/mcp-oauth-repository.ts";

export function buildAuthorizationUrl(
  discovery: McpOAuthDiscovery,
  flow: {
    clientId: string;
    redirectUri: string;
    state: string;
    challenge: string;
  },
): string {
  const url = new URL(discovery.authorizationEndpoint);
  const parameters: [string, string][] = [
    ["response_type", "code"],
    ["client_id", flow.clientId],
    ["redirect_uri", flow.redirectUri],
    ["state", flow.state],
    ["code_challenge", flow.challenge],
    ["code_challenge_method", "S256"],
    ["resource", discovery.resource],
    ...(discovery.scopes.length === 0
      ? []
      : ([["scope", discovery.scopes.join(" ")]] as [string, string][])),
  ];
  for (const [name, value] of parameters) url.searchParams.set(name, value);
  return url.toString();
}
