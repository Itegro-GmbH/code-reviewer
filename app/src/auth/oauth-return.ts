// SPDX-License-Identifier: LicenseRef-Proprietary

// Carrying a pending authorization request of the factory MCP (#1144) through the sign in. An AI app sends a person to
// `/oauth/authorize`; without a session they are sent to `/login?oauth=<request id>`, and after the sign in they land on the consent page
// of that request. Only a value shaped like a request id (192 random bits, base64url) is ever carried, and the only place it leads to is
// the consent page, so the parameter cannot send a person anywhere else (the same rule as the invitation link, invitation-return.ts).

/** The consent page of the factory MCP's OAuth server (#1144): where a person lands after the sign in. */
export const OAUTH_CONSENT_PATH = "/oauth/consent";

/** The id of a pending authorization request: 192 random bits, base64url (`factory-mcp/oauth/tokens.ts` makes them). */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function consentPath(requestId: string): string {
  return `${OAUTH_CONSENT_PATH}?request=${encodeURIComponent(requestId)}`;
}

/** The request id if the value is one, else null: what the login page puts into its forms. */
export function oauthRequestIdOf(value: unknown): string | null {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value)
    ? value
    : null;
}

/**
 * Where a person goes right after signing in, given where the sign in would send them (`landing`) and what they came from. An invitation
 * link wins (its page is the one that has to be reached), then a pending authorization request, and both only when `landing` is the
 * start page: a person who still has to verify the address or has no workspace goes to the page that says so.
 */
export function landingWithOauth(landing: string, requestId: unknown): string {
  const id = oauthRequestIdOf(requestId);
  return id === null || landing !== "/" ? landing : consentPath(id);
}
