// SPDX-License-Identifier: LicenseRef-Proprietary

// One Jira issue read through a connection (#1039): `GET /rest/api/3/issue/{key}` with the fields the neutral ticket needs, through
// `JiraTokens.request` (the token is refreshed and never seen here). Used when a run starts (the ticket as Jira has it now) and as the stale
// guard of a status trigger (the issue's CURRENT status). Values, never exceptions.
import type { JiraReadErrorCode } from "./errors.ts";
import { isJiraIssueKey, readJiraIssue, type JiraIssue } from "./issue.ts";
import type { JiraTokens } from "./tokens.ts";

export const ISSUE_FIELDS =
  "summary,description,status,issuetype,assignee,labels,parent,updated";

export type JiraIssueRead =
  | { ok: true; issue: JiraIssue | null }
  | { ok: false; error: JiraReadErrorCode };

export type JiraIssueReader = {
  /** The issue with this key, null when there is none (Jira's 404, or a text that is no issue key: no call is made for it). */
  read(connectionId: string, key: string): Promise<JiraIssueRead>;
};

export function createJiraIssueReader({
  tokens,
  siteUrlOf,
}: {
  tokens: JiraTokens;
  /** The address of the connection's site (`https://acme.atlassian.net`), for the link of the issue; undefined for no such connection. */
  siteUrlOf(connectionId: string): Promise<string | undefined>;
}): JiraIssueReader {
  return {
    async read(connectionId, key) {
      if (!isJiraIssueKey(key)) return { ok: true, issue: null };
      const result = await tokens.request(
        connectionId,
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`,
        { headers: { accept: "application/json" } },
      );
      if (!result.ok) return { ok: false, error: result.error };
      const { response } = result;
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: true, issue: null };
      }
      if (response.status === 401 || response.status === 403)
        return { ok: false, error: "jira_forbidden" };
      if (!response.ok) return { ok: false, error: "jira_unavailable" };
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, error: "jira_unavailable" };
      }
      const issue = readJiraIssue(body, await siteUrlOf(connectionId));
      return issue === undefined
        ? { ok: false, error: "jira_unavailable" }
        : { ok: true, issue };
    },
  };
}
