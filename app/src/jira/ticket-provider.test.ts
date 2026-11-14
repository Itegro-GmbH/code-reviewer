// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira ticket provider (#1039): reads a ticket of the project's Jira source; write-back is not part of it until #1040.
import { describe, expect, it } from "vitest";
import type { Integration } from "../integrations/types.ts";
import type { JiraIssue } from "./issue.ts";
import type { JiraIssueReader } from "./issue-reader.ts";
import { createJiraTicketProvider } from "./ticket-provider.ts";

const issue: JiraIssue = {
  id: "1",
  key: "PROJ-7",
  projectKey: "PROJ",
  number: 7,
  title: "Fix",
  body: "text",
  status: "In Progress",
  statusCategory: "indeterminate",
  type: "Bug",
  assignees: ["Ada"],
  labels: ["a"],
  url: "https://acme.atlassian.net/browse/PROJ-7",
  updatedAt: "2026-11-14T10:00:00.000Z",
};

const scope = (jira = { connectionId: "c1", projectKey: "PROJ" }) => ({
  integration: { id: "i", workspaceId: "ws" } as Integration,
  repo: {
    integrationId: "i",
    externalId: "1",
    fullName: "acme/widgets",
    url: "u",
  },
  jira,
});

function provider(read: JiraIssueReader["read"]) {
  const workspaces: string[] = [];
  return {
    workspaces,
    provider: createJiraTicketProvider({
      readerFor: async (workspaceId) => {
        workspaces.push(workspaceId);
        return { read };
      },
    }),
  };
}

describe("the Jira ticket provider", () => {
  // #1039-T01
  it("reads a ticket of the project's Jira project as the neutral ticket, with its status", async () => {
    const p = provider(async () => ({ ok: true, issue }));
    expect(await p.provider.readTicket?.(scope(), "PROJ-7")).toEqual({
      key: "PROJ-7",
      title: "Fix",
      body: "text",
      url: "https://acme.atlassian.net/browse/PROJ-7",
      labels: ["a"],
      assignees: ["Ada"],
      type: "Bug",
      status: "In Progress",
    });
    expect(p.workspaces).toEqual(["ws"]);
  });

  // #1039
  it("has no ticket for another project's issue, a missing issue or a scope without a Jira project", async () => {
    const other = provider(async () => ({
      ok: true,
      issue: { ...issue, key: "OTHER-1", projectKey: "OTHER" },
    }));
    expect(await other.provider.readTicket?.(scope(), "OTHER-1")).toBeNull();
    const none = provider(async () => ({ ok: true, issue: null }));
    expect(await none.provider.readTicket?.(scope(), "PROJ-9")).toBeNull();
    const noJira = provider(async () => ({ ok: true, issue }));
    const github = { ...scope(), jira: undefined };
    expect(await noJira.provider.readTicket?.(github, "PROJ-7")).toBeNull();
  });

  // #1039
  it("rejects when Jira cannot be asked, so a caller can tell it from no ticket", async () => {
    const p = provider(async () => ({ ok: false, error: "jira_unavailable" }));
    await expect(p.provider.readTicket?.(scope(), "PROJ-7")).rejects.toThrow(
      "jira_unavailable",
    );
  });

  // #1039
  it("names the keys it can read and has no write-back yet", () => {
    const p = provider(async () => ({ ok: true, issue: null }));
    expect(p.provider.id).toBe("jira");
    expect(p.provider.isTicketKey?.("PROJ-1")).toBe(true);
    expect(p.provider.isTicketKey?.("15")).toBe(false);
    expect(p.provider.commentOnTicket).toBeUndefined();
    expect(p.provider.changeTicketLabels).toBeUndefined();
    expect(p.provider.setTicketStatus).toBeUndefined();
  });
});
