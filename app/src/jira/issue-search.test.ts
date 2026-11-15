// SPDX-License-Identifier: LicenseRef-Proprietary

// The JQL search of a Jira project's issues (#1040): what is sent, and how each answer is read.
import { describe, expect, it } from "vitest";
import { createJiraIssueSearch } from "./issue-search.ts";
import type { JiraRequestResult } from "./tokens.ts";

const issueJson = (key: string) => ({
  id: key.replace(/\D/g, "") + "00",
  key,
  fields: {
    summary: `Issue ${key}`,
    description: null,
    status: { name: "To Do", statusCategory: { key: "new" } },
    issuetype: { name: "Task" },
    labels: [],
    updated: "2026-11-14T10:00:00.000+0000",
  },
});

const reply = (status: number, body?: unknown): JiraRequestResult => ({
  ok: true,
  response: new Response(body === undefined ? null : JSON.stringify(body), {
    status,
  }),
});

function searchAnswering(answer: () => JiraRequestResult) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const search = createJiraIssueSearch({
    tokens: {
      async request(_connection, path, init) {
        calls.push({ path, ...(init === undefined ? {} : { init }) });
        return answer();
      },
    },
    siteUrlOf: async () => "https://acme.atlassian.net",
  });
  return { calls, search };
}

describe("the JQL search of a project's issues", () => {
  // #1040-T04
  it("posts the JQL of the project with the fields of the neutral ticket and the token of the page", async () => {
    const { search, calls } = searchAnswering(() =>
      reply(200, { issues: [issueJson("PROJ-1")], nextPageToken: "tok-2" }),
    );

    const page = await search.page("conn-1", "PROJ", "tok-1");

    expect(page).toMatchObject({ ok: true, next: "tok-2", skipped: 0 });
    expect(page.ok && page.issues[0]).toMatchObject({
      key: "PROJ-1",
      url: "https://acme.atlassian.net/browse/PROJ-1",
    });
    expect(calls[0]?.path).toBe("/rest/api/3/search/jql");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      jql: 'project = "PROJ" ORDER BY created ASC',
      fields: [
        "summary",
        "description",
        "status",
        "issuetype",
        "assignee",
        "labels",
        "parent",
        "updated",
      ],
      maxResults: 100,
      nextPageToken: "tok-1",
    });
  });

  it("has no next page on the last one, counts what it cannot read and drops an issue of another project", async () => {
    const { search } = searchAnswering(() =>
      reply(200, {
        isLast: true,
        issues: [issueJson("PROJ-1"), { nonsense: true }, issueJson("OTHER-2")],
      }),
    );
    expect(await search.page("c", "PROJ")).toMatchObject({
      ok: true,
      skipped: 2,
    });
    const last = await search.page("c", "PROJ");
    expect(last.ok && last.next).toBeUndefined();
  });

  it("never puts a text that is no project key into the JQL, and reads the failures as codes", async () => {
    const quoted = searchAnswering(() => reply(200, { issues: [] }));
    expect(await quoted.search.page("c", 'PROJ" OR 1=1 --')).toEqual({
      ok: false,
      error: "jira_project_not_found",
    });
    expect(quoted.calls).toHaveLength(0);
    for (const [status, error] of [
      [401, "jira_forbidden"],
      [403, "jira_forbidden"],
      [400, "jira_project_not_found"],
      [500, "jira_unavailable"],
    ] as const)
      expect(
        await searchAnswering(() => reply(status)).search.page("c", "PROJ"),
      ).toEqual({ ok: false, error });
    expect(
      await searchAnswering(() => reply(200, { nothing: true })).search.page(
        "c",
        "PROJ",
      ),
    ).toEqual({ ok: false, error: "jira_unavailable" });
  });
});
