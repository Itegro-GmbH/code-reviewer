// SPDX-License-Identifier: LicenseRef-Proprietary

// The one switch of the MCP registry (#1050): whether the addresses of MCP servers may be plain http and name this machine. Off by
// default and in every deployment: an MCP server address is entered by a person, and the server connects to it, so only https to a
// public host is accepted. Only the test stack sets `ALLOW_TEST_MCP_ENDPOINTS=true` (the fake MCP server in `fakes/mcp` listens on
// loopback), the same way `ALLOW_TEST_ATLASSIAN_ENDPOINTS` and `ALLOW_TEST_GITHUB_ENDPOINTS` point the app at the fakes. Even with the
// flag, a private network, a link-local address and the metadata service stay refused: it opens this machine only.
type Env = Readonly<Record<string, string | undefined>>;

export const ALLOW_TEST_MCP_ENDPOINTS_VARIABLE = "ALLOW_TEST_MCP_ENDPOINTS";

/** True exactly when the flag is `true` (surrounding whitespace ignored; `TRUE` or `1` are not). */
export function mcpTestEndpointsAllowed(env: Env): boolean {
  return env[ALLOW_TEST_MCP_ENDPOINTS_VARIABLE]?.trim() === "true";
}
