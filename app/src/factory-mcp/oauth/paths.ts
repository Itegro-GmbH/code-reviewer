// SPDX-License-Identifier: LicenseRef-Proprietary

// The addresses of the factory MCP server and its OAuth server, in one place: the routes, the metadata, the proxy's list of public paths
// and the docs all read them here. Everything is below the app's own address (`BETTER_AUTH_URL`).

/** The Streamable HTTP endpoint: the one protected resource, and the only audience a token can have. */
export const MCP_ENDPOINT_PATH = "/api/mcp";

/** RFC 9728: where the protected resource metadata lives (with and without the path of the resource appended). */
export const PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource";
/** RFC 8414: the authorization server metadata (the issuer has no path). */
export const AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server";

export const OAUTH_PATHS = {
  /** A browser is sent here by the client; it checks the request and goes on to the consent page (or the sign in). */
  authorize: "/oauth/authorize",
  /** The consent page: workspace and scope. Behind the sign in. */
  consent: "/oauth/consent",
  /** Where the consent form posts. Behind the sign in. */
  consentSubmit: "/api/oauth/consent",
  register: "/api/oauth/register",
  token: "/api/oauth/token",
  revoke: "/api/oauth/revoke",
} as const;

/** The query parameter with which the sign in page carries a pending authorization request through the sign in. */
export const OAUTH_RETURN_PARAM = "oauth";

export function consentPath(requestId: string): string {
  return `${OAUTH_PATHS.consent}?request=${encodeURIComponent(requestId)}`;
}
