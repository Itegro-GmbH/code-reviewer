// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the Jira connection (#1037): what a flow ended with (the code in the address of the settings page), why a connection is
// broken, and what a failed call of the page says. The routes and the service speak in stable codes; this is the one place that turns
// them into copy. Names of sites and accounts come from Atlassian and are shown as text, never here.
import type { JiraResultCode } from "../errors.ts";
import { isJiraResultCode } from "../errors.ts";

export type ResultTone = "success" | "info" | "error";

const RESULT_COPY: Record<JiraResultCode, { tone: ResultTone; text: string }> =
  {
    connected: { tone: "success", text: "The Jira site is connected." },
    reconnected: {
      tone: "success",
      text: "The Jira site is connected again.",
    },
    site_choice_ready: {
      tone: "info",
      text: "Your Atlassian account gave access to several Jira sites. Choose the one to connect; connect again for another site.",
    },
    jira_not_configured: {
      tone: "error",
      text: "Jira is not set up on this installation: the Atlassian app's client id and secret are missing.",
    },
    workspace_role_required: {
      tone: "error",
      text: "Only an Owner or an Admin of the workspace can connect Jira.",
    },
    state_invalid: {
      tone: "error",
      text: "That attempt can no longer be completed (it expired, was used already, or belongs to another browser session). Start again with Connect Jira.",
    },
    access_denied: {
      tone: "info",
      text: "You did not give access at Atlassian, so nothing was connected.",
    },
    jira_authorization_refused: {
      tone: "error",
      text: "Atlassian did not accept the authorization. Nothing was connected; try again.",
    },
    jira_unreachable: {
      tone: "error",
      text: "Atlassian could not be reached. Nothing was connected; try again in a moment.",
    },
    jira_no_site: {
      tone: "error",
      text: "Your Atlassian account gave access to no Jira Cloud site. Nothing was connected.",
    },
    jira_site_mismatch: {
      tone: "error",
      text: "You gave access to other sites than the one being reconnected. Choose that site at Atlassian.",
    },
    jira_choice_invalid: {
      tone: "error",
      text: "That choice is no longer available (it took too long, or it was not your attempt). Start again with Connect Jira.",
    },
    jira_connection_not_found: {
      tone: "error",
      text: "That Jira connection does not exist in this workspace.",
    },
    jira_connection_in_use: {
      tone: "error",
      text: "A project still uses this connection, so it was not removed.",
    },
    rate_limited: {
      tone: "error",
      text: "Too many attempts. Wait a few minutes and try again.",
    },
    unavailable: {
      tone: "error",
      text: "Something went wrong on our side. Nothing was changed; try again.",
    },
  };

/** What a flow that just ended says, from the `jira` code of the address; null for a missing or unknown code. */
export function describeJiraResult(
  code: unknown,
): { tone: ResultTone; text: string } | null {
  return isJiraResultCode(code) ? RESULT_COPY[code] : null;
}

const BROKEN_COPY: Record<string, string> = {
  jira_refresh_refused:
    "Atlassian no longer accepts this connection (the app was removed in the Atlassian account, or the access ran out). Connect it again.",
  jira_tokens_unreadable:
    "The stored access cannot be read any more. Connect it again.",
};

/** Why a connection is broken, for a code of the row. */
export function describeBrokenConnection(code: string | null): string {
  return (
    (code === null ? undefined : BROKEN_COPY[code]) ??
    "This connection does not work. Connect it again."
  );
}

const FAILURE_COPY: Record<string, string> = {
  forbidden: "Only an Owner or an Admin of the workspace can do that.",
  UNAUTHENTICATED: "You are signed out. Sign in again.",
  ACCESS_DENIED: "You have no access to this workspace.",
  NETWORK_ERROR: "The server could not be reached. Try again.",
  cross_site_request: "That request did not come from this page.",
};

/** What a failed call of the page says: a code of the routes, a refusal of a request, or a transport code. */
export function describeJiraFailure(
  code: string,
  projects?: { id: string; name: string }[],
): string {
  if (code === "jira_connection_in_use" && projects !== undefined)
    return `${RESULT_COPY.jira_connection_in_use.text} Used by: ${projects.map((p) => p.name).join(", ")}.`;
  if (isJiraResultCode(code)) return RESULT_COPY[code].text;
  return FAILURE_COPY[code] ?? "Something went wrong. Try again.";
}
