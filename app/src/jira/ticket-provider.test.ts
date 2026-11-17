// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira ticket provider (#1039, #1040): reads and writes the tickets of the project's Jira source.
import { describe, expect, it } from "vitest";
import type { Integration } from "../integrations/types.ts";
import type { JiraIssue } from "./issue.ts";
import type { JiraIssueReader } from "./issue-reader.ts";
import { createJiraTicketProvider } from "./ticket-provider.ts";
import type { JiraTicketWriter } from "./ticket-writer.ts";

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
  it("names the keys it can read, and without a writer it only reads", () => {
    const p = provider(async () => ({ ok: true, issue: null }));
    expect(p.provider.id).toBe("jira");
    expect(p.provider.isTicketKey?.("PROJ-1")).toBe(true);
    expect(p.provider.isTicketKey?.("15")).toBe(false);
    expect(p.provider.commentOnTicket).toBeUndefined();
    expect(p.provider.changeTicketLabels).toBeUndefined();
    expect(p.provider.setTicketStatus).toBeUndefined();
  });
});

describe("the Jira ticket provider that writes (#1040)", () => {
  function writing() {
    const calls: unknown[][] = [];
    const record =
      <T>(name: string, result: T) =>
      async (...args: unknown[]): Promise<T> => {
        calls.push([name, ...args]);
        return result;
      };
    const writer: JiraTicketWriter = {
      comment: record("comment", { url: "u", existing: false, id: "1" }),
      updateComment: record("updateComment", undefined),
      changeLabels: record("changeLabels", { labels: ["a"] }),
      setStatus: record("setStatus", {
        kind: "moved" as const,
        status: "Done",
      }),
    };
    const workspaces: string[] = [];
    const p = createJiraTicketProvider({
      readerFor: async () => ({
        read: async () => ({ ok: true, issue: null }),
      }),
      writerFor: async (workspaceId) => {
        workspaces.push(workspaceId);
        return writer;
      },
    });
    return { p, calls, workspaces };
  }

  // #1040-T01
  it("is boardless, writes through the connection and project of the scope in the workspace of the integration, and passes the key on", async () => {
    const { p, calls, workspaces } = writing();
    expect(p.boardless).toBe(true);

    expect(
      await p.commentOnTicket?.(scope(), "PROJ-7", "body", { marker: "m" }),
    ).toEqual({ url: "u", existing: false, id: "1" });
    await p.updateTicketComment?.(scope(), "PROJ-7", "5", "new");
    expect(
      await p.changeTicketLabels?.(scope(), "PROJ-7", {
        add: ["a"],
        remove: [],
      }),
    ).toEqual({ labels: ["a"] });
    expect(
      await p.setTicketStatus?.(scope(), "PROJ-7", { status: "Done" }),
    ).toEqual({ kind: "moved", status: "Done" });

    expect(calls).toEqual([
      ["comment", "c1", "PROJ-7", "body", { marker: "m" }],
      ["updateComment", "c1", "PROJ-7", "5", "new", undefined],
      ["changeLabels", "c1", "PROJ-7", { add: ["a"], remove: [] }, undefined],
      ["setStatus", "c1", "PROJ", "PROJ-7", "Done", undefined],
    ]);
    expect(new Set(workspaces)).toEqual(new Set(["ws"]));
  });

  // #1040-T01
  it("writes to no issue of another Jira project and to none without a Jira source, before the writer is asked", async () => {
    const { p, calls } = writing();
    await expect(
      p.commentOnTicket?.(scope(), "OTHER-1", "body"),
    ).rejects.toMatchObject({ code: "ticket_not_found" });
    await expect(
      p.setTicketStatus?.(scope(), "OTHER-1", { status: "Done" }),
    ).rejects.toMatchObject({ code: "ticket_not_found" });
    await expect(
      p.changeTicketLabels?.({ ...scope(), jira: undefined }, "PROJ-7", {
        add: ["a"],
        remove: [],
      }),
    ).rejects.toMatchObject({ code: "ticket_not_found" });
    expect(calls).toEqual([]);
  });
});
