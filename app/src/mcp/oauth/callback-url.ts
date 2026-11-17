// SPDX-License-Identifier: LicenseRef-Proprietary

// The redirect address of the OAuth flow of MCP servers (#1051): where an authorization server sends the browser after the consent page. Made
// from the configured public address of the app, never from a header. No server-only import: the MCP page shows it as a hint for an
// authorization server that needs a client entered by hand.
export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

export function mcpOAuthCallbackUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${MCP_OAUTH_CALLBACK_PATH}`;
}
