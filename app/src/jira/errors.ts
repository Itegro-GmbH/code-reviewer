// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable codes of the Jira Cloud connection (#1037). A page translates a code to copy (ui/messages.ts), never the other way round,
// and no code carries a token, a code of Atlassian's, a state or a response body. Three sets:
//
// - the refusals of a request (`JIRA_ERROR_CODES`): nothing was connected, removed or changed;
// - the reasons a connection is `broken` (`JIRA_BROKEN_CODES`): stored on the row, shown on the page, mended by connecting again;
// - what a call through a connection can fail with (`JIRA_CALL_ERROR_CODES`): a broken connection and an Atlassian that is not reachable.
export const JIRA_ERROR_CODES = [
  /** The client id or secret of the Atlassian app is not set: the feature is off. */
  "jira_not_configured",
  /** The signed in person is not (or no longer) an Owner or Admin of the workspace. */
  "workspace_role_required",
  /** The state is forged, expired, used, or belongs to another person, session or purpose. */
  "state_invalid",
  /** The person said no at Atlassian. */
  "access_denied",
  /** Atlassian did not accept the authorization (a code that does not work, no refresh token): the person has to try again. */
  "jira_authorization_refused",
  /** Atlassian could not be reached or answered something unusable; nothing was connected. */
  "jira_unreachable",
  /** The grant covers no Jira site. */
  "jira_no_site",
  /** Connecting again for a site, the person granted another one. */
  "jira_site_mismatch",
  /** The choice of a site is not (any more) among the sites of the person's grant, or the grant was left too long. */
  "jira_choice_invalid",
  /** The connection is not one of this workspace. */
  "jira_connection_not_found",
  /** A project still uses the connection as its ticket source; the answer names the projects. */
  "jira_connection_in_use",
  "rate_limited",
  /** The counters or the database could not be read; nothing was done. */
  "unavailable",
] as const;
export type JiraErrorCode = (typeof JIRA_ERROR_CODES)[number];

export const JIRA_ERROR_STATUS: Record<JiraErrorCode, number> = {
  jira_not_configured: 404,
  workspace_role_required: 403,
  state_invalid: 400,
  access_denied: 400,
  jira_authorization_refused: 400,
  jira_unreachable: 502,
  jira_no_site: 400,
  jira_site_mismatch: 400,
  jira_choice_invalid: 400,
  jira_connection_not_found: 404,
  jira_connection_in_use: 409,
  rate_limited: 429,
  unavailable: 503,
};

export const JIRA_BROKEN_CODES = [
  /** Atlassian refused the refresh token: the person removed the app, the grant ran out, or the token was used twice. */
  "jira_refresh_refused",
  /** The stored tokens cannot be decrypted (another `APP_SECRET`, or the row was changed). */
  "jira_tokens_unreadable",
] as const;
export type JiraBrokenCode = (typeof JIRA_BROKEN_CODES)[number];

export const JIRA_CALL_ERROR_CODES = [
  /** The connection is broken: a person has to connect it again (`brokenCode` says why). */
  "jira_connection_broken",
  /** No such connection in this workspace. */
  "jira_connection_not_found",
  /** Atlassian could not be reached for the refresh; the connection is untouched and the call can be tried again. */
  "jira_unavailable",
] as const;
export type JiraCallErrorCode = (typeof JIRA_CALL_ERROR_CODES)[number];

/** What a page can be told about a flow that ended: a refusal, or one of these. */
export const JIRA_RESULT_CODES = [
  "connected",
  "reconnected",
  /** The grant covers several sites: the page offers the choice. */
  "site_choice_ready",
  ...JIRA_ERROR_CODES,
] as const;
export type JiraResultCode = (typeof JIRA_RESULT_CODES)[number];

export function isJiraResultCode(value: unknown): value is JiraResultCode {
  return (
    typeof value === "string" &&
    (JIRA_RESULT_CODES as readonly string[]).includes(value)
  );
}
