// SPDX-License-Identifier: LicenseRef-Proprietary

// The issues of a Jira project read page by page (#1040): JQL `project = "KEY"` through `POST /rest/api/3/search/jql` (the enhanced search of
// Jira Cloud, paged by `nextPageToken`; the old `/search` is retired), with the fields the neutral ticket needs. The factory reads the whole
// project this way to start its ticket mirror and to rebuild it (the webhook only brings what changes after it is registered). Through
// `JiraTokens.request`, so the token is refreshed and never seen here. Values, never exceptions.
import type { JiraReadErrorCode } from "./errors.ts";
import { ISSUE_FIELDS } from "./issue-reader.ts";
import { readJiraIssue, type JiraIssue } from "./issue.ts";
import { JIRA_PROJECT_KEY } from "./projects.ts";
import type { JiraTokens } from "./tokens.ts";

/** Jira's page size for this search: the most it gives with these fields. */
export const SEARCH_PAGE_SIZE = 100;

export type JiraIssuePage =
  | {
      ok: true;
      issues: JiraIssue[];
      /** Entries of the page that were no issue the factory can read (counted, never an error). */
      skipped: number;
      /** The token of the next page; undefined on the last one. */
      next?: string;
    }
  | { ok: false; error: JiraReadErrorCode };

export type JiraIssueSearch = {
  /** One page of the issues of the project `projectKey`, oldest first; `after` is the `next` of the page before. */
  page(
    connectionId: string,
    projectKey: string,
    after?: string,
    signal?: AbortSignal,
  ): Promise<JiraIssuePage>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createJiraIssueSearch({
  tokens,
  siteUrlOf,
}: {
  tokens: Pick<JiraTokens, "request">;
  siteUrlOf(connectionId: string): Promise<string | undefined>;
}): JiraIssueSearch {
  return {
    async page(connectionId, projectKey, after, signal) {
      if (!JIRA_PROJECT_KEY.test(projectKey))
        return { ok: false, error: "jira_project_not_found" };
      let result;
      try {
        result = await tokens.request(connectionId, "/rest/api/3/search/jql", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jql: `project = "${projectKey}" ORDER BY created ASC`,
            fields: ISSUE_FIELDS.split(","),
            maxResults: SEARCH_PAGE_SIZE,
            ...(after === undefined ? {} : { nextPageToken: after }),
          }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        return { ok: false, error: "jira_unavailable" };
      }
      if (!result.ok) return { ok: false, error: result.error };
      const { response } = result;
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, error: "jira_forbidden" };
      }
      if (response.status === 400 || response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, error: "jira_project_not_found" };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, error: "jira_unavailable" };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, error: "jira_unavailable" };
      }
      if (!isRecord(body) || !Array.isArray(body.issues))
        return { ok: false, error: "jira_unavailable" };
      const siteUrl = await siteUrlOf(connectionId);
      const issues: JiraIssue[] = [];
      let skipped = 0;
      for (const entry of body.issues as unknown[]) {
        const issue = readJiraIssue(entry, siteUrl);
        // An issue of another project cannot be in the answer of this query; one the reader does not know is counted.
        if (issue === undefined || issue.projectKey !== projectKey)
          skipped += 1;
        else issues.push(issue);
      }
      const next =
        body.isLast !== true &&
        typeof body.nextPageToken === "string" &&
        body.nextPageToken !== ""
          ? body.nextPageToken
          : undefined;
      return {
        ok: true,
        issues,
        skipped,
        ...(next === undefined ? {} : { next }),
      };
    },
  };
}
