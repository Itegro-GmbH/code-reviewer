// SPDX-License-Identifier: LicenseRef-Proprietary

// One Jira issue read through a connection (#1039): the fields the neutral ticket needs, and what each answer of Jira means.
import { describe, expect, it } from "vitest";
import { createJiraIssueReader } from "./issue-reader.ts";
import type { JiraRequestResult, JiraTokens } from "./tokens.ts";

const issueJson = {
  id: "10042",
  key: "PROJ-7",
  fields: {
    summary: "Fix the login",
    description: null,
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    issuetype: { name: "Task" },
    labels: [],
    updated: "2026-11-14T10:00:00.000+0000",
  },
};

function readerAnswering(answer: (path: string) => JiraRequestResult) {
  const paths: string[] = [];
  const tokens: JiraTokens = {
    use: () => Promise.reject(new Error("not used")),
    async request(_connectionId, path) {
      paths.push(path);
      return answer(path);
    },
  };
  return {
    paths,
    reader: createJiraIssueReader({
      tokens,
      siteUrlOf: async () => "https://acme.atlassian.net",
    }),
  };
}

const reply = (status: number, body?: unknown): JiraRequestResult => ({
  ok: true,
  response: new Response(body === undefined ? null : JSON.stringify(body), {
    status,
  }),
});

describe("the Jira issue reader", () => {
  // #1039-T01
  it("asks for the fields of the neutral ticket and maps the answer", async () => {
    const { reader, paths } = readerAnswering(() => reply(200, issueJson));
    const result = await reader.read("conn-1", "PROJ-7");
    expect(result).toMatchObject({
      ok: true,
      issue: {
        key: "PROJ-7",
        status: "In Progress",
        url: "https://acme.atlassian.net/browse/PROJ-7",
      },
    });
    expect(paths).toHaveLength(1);
    const url = new URL(`https://x.test${paths[0] ?? ""}`);
    expect(url.pathname).toBe("/rest/api/3/issue/PROJ-7");
    expect(url.searchParams.get("fields")).toBe(
      "summary,description,status,issuetype,assignee,labels,parent,updated",
    );
  });

  // #1039
  it("says there is no issue for a 404 and fails for the other answers", async () => {
    expect(
      await readerAnswering(() => reply(404)).reader.read("c", "PROJ-7"),
    ).toEqual({ ok: true, issue: null });
    for (const [status, error] of [
      [401, "jira_forbidden"],
      [403, "jira_forbidden"],
      [500, "jira_unavailable"],
    ] as const)
      expect(
        await readerAnswering(() => reply(status)).reader.read("c", "PROJ-7"),
      ).toEqual({ ok: false, error });
  });

  // #1039
  it("refuses a text that is no issue key without asking Jira, and an answer that is no issue", async () => {
    const asked = readerAnswering(() => reply(200, issueJson));
    expect(await asked.reader.read("c", "../../etc")).toEqual({
      ok: true,
      issue: null,
    });
    expect(asked.paths).toEqual([]);
    expect(
      await readerAnswering(() => reply(200, { nope: 1 })).reader.read(
        "c",
        "PROJ-7",
      ),
    ).toEqual({ ok: false, error: "jira_unavailable" });
  });

  // #1039
  it("passes a failure of the connection through", async () => {
    const { reader } = readerAnswering(() => ({
      ok: false,
      error: "jira_connection_broken",
    }));
    expect(await reader.read("c", "PROJ-7")).toEqual({
      ok: false,
      error: "jira_connection_broken",
    });
  });
});
