// SPDX-License-Identifier: LicenseRef-Proprietary

// The one switch of the MCP registry (#1050): whether the addresses of MCP servers may be plain http and name this machine. Off by
// default and in every deployment: an MCP server address is entered by a person, and the server connects to it, so only https to a
// public host is accepted. Only the test stack sets `ALLOW_TEST_MCP_ENDPOINTS=true` (the fake MCP server in `fakes/mcp` listens on
// loopback), the same way `ALLOW_TEST_ATLASSIAN_ENDPOINTS` and `ALLOW_TEST_GITHUB_ENDPOINTS` point the app at the fakes. Even with the
// flag, a private network, a link-local address and the metadata service stay refused: it opens this machine only. A production deployment (`VERCEL_ENV=production`) ignores the flag and says so at the start: a guard the sibling flags do not have.
type Env = Readonly<Record<string, string | undefined>>;

export const ALLOW_TEST_MCP_ENDPOINTS_VARIABLE = "ALLOW_TEST_MCP_ENDPOINTS";

/** The flag as it is set, whatever the deployment is. */
const flagSet = (env: Env): boolean =>
  env[ALLOW_TEST_MCP_ENDPOINTS_VARIABLE]?.trim() === "true";

/** A production deployment never honours the flag: a variable set by mistake there must not open plain http and this machine. */
const isProduction = (env: Env): boolean =>
  env.VERCEL_ENV?.trim() === "production";

/** True exactly when the flag is `true` (surrounding whitespace ignored; `TRUE` or `1` are not) and the deployment is not production. */
export function mcpTestEndpointsAllowed(env: Env): boolean {
  return flagSet(env) && !isProduction(env);
}

/** The line to log at the start when the flag is set, else null. */
export function mcpTestEndpointsLine(env: Env): string | null {
  if (!flagSet(env)) return null;
  return isProduction(env)
    ? `[mcp] ${ALLOW_TEST_MCP_ENDPOINTS_VARIABLE} is set but ignored: this is a production deployment. Remove the variable.`
    : `[mcp] ${ALLOW_TEST_MCP_ENDPOINTS_VARIABLE} is on: plain http and this machine are accepted as MCP server addresses (test stack only).`;
}

export function logMcpTestEndpoints(
  env: Env,
  log: (line: string) => void = (line) => console.warn(line),
): void {
  const line = mcpTestEndpointsLine(env);
  if (line !== null) log(line);
}
