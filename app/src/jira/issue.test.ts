// SPDX-License-Identifier: LicenseRef-Proprietary

// A Jira issue as the factory's neutral ticket (#1039): key, title, body, status, type, assignee, labels, parent and address.
import { describe, expect, it } from "vitest";
import {
  issueNumberOfKey,
  isJiraIssueKey,
  readJiraIssue,
  type JiraIssue,
} from "./issue.ts";

const SITE = "https://acme.atlassian.net";

const raw = (fields: Record<string, unknown> = {}) => ({
  id: "10042",
  key: "PROJ-7",
  fields: {
    summary: "Fix the login",
    description: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "It fails." }] },
      ],
    },
    status: {
      name: "Ready for agent",
      statusCategory: { key: "indeterminate" },
    },
    issuetype: { name: "Bug" },
    assignee: { accountId: "acc-1", displayName: "Ada Lovelace" },
    labels: ["backend", "urgent"],
    parent: { key: "PROJ-1" },
    updated: "2026-11-14T10:30:00.123+0100",
    ...fields,
  },
});

describe("readJiraIssue", () => {
  // #1039-T01
  it("maps the fields of an issue to the neutral ticket", () => {
    const issue = readJiraIssue(raw(), SITE);
    expect(issue).toEqual<JiraIssue>({
      id: "10042",
      key: "PROJ-7",
      projectKey: "PROJ",
      number: 7,
      title: "Fix the login",
      body: "It fails.",
      status: "Ready for agent",
      statusCategory: "indeterminate",
      type: "Bug",
      assignees: ["Ada Lovelace"],
      labels: ["backend", "urgent"],
      parentKey: "PROJ-1",
      url: "https://acme.atlassian.net/browse/PROJ-7",
      updatedAt: "2026-11-14T09:30:00.123Z",
    });
  });

  // #1058
  it("keeps the id of the status, which is the same in every language", () => {
    const issue = readJiraIssue(
      raw({ status: { id: "10100", name: "Zu erledigen" } }),
      SITE,
    );
    expect(issue).toMatchObject({ status: "Zu erledigen", statusId: "10100" });
  });

  // #1039
  it("treats missing fields as empty and a done status category as done", () => {
    const issue = readJiraIssue(
      raw({
        description: null,
        assignee: null,
        labels: undefined,
        parent: undefined,
        issuetype: undefined,
        status: { name: "Done", statusCategory: { key: "done" } },
      }),
      SITE,
    );
    expect(issue).toMatchObject({
      body: "",
      assignees: [],
      labels: [],
      type: "",
      statusCategory: "done",
    });
    expect(issue?.parentKey).toBeUndefined();
  });

  // #1039
  it("refuses a value that is no issue", () => {
    expect(readJiraIssue(null, SITE)).toBeUndefined();
    expect(readJiraIssue({ id: "1", key: "no key", fields: {} }, SITE)).toBe(
      undefined,
    );
    expect(readJiraIssue({ id: "1", key: "PROJ-1" }, SITE)).toBeUndefined();
    expect(
      readJiraIssue({ id: "1", key: "PROJ-1", fields: { summary: 5 } }, SITE),
    ).toBeUndefined();
  });

  // #1039
  it("has no link without the address of the site", () => {
    expect(readJiraIssue(raw(), undefined)?.url).toBe("");
  });
});

describe("issue keys", () => {
  // #1039
  it("recognises keys and takes the number from the end", () => {
    expect(isJiraIssueKey("PROJ-123")).toBe(true);
    expect(isJiraIssueKey("A1_B-9")).toBe(true);
    expect(isJiraIssueKey("proj-1")).toBe(false);
    expect(isJiraIssueKey("PROJ-0")).toBe(false);
    expect(isJiraIssueKey("PROJ-1; drop")).toBe(false);
    expect(issueNumberOfKey("PROJ-123")).toBe(123);
    expect(issueNumberOfKey("nope")).toBeUndefined();
  });
});
