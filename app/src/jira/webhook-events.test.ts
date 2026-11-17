// SPDX-License-Identifier: LicenseRef-Proprietary

// What a delivery of a Jira Cloud dynamic webhook says (#1039): the events the factory follows and the status change in a changelog.
import { describe, expect, it } from "vitest";
import { parseJiraDelivery } from "./webhook-events.ts";

const SITE = "https://acme.atlassian.net";

const issue = (status = "In Progress", key = "PROJ-7") => ({
  id: "10042",
  key,
  fields: {
    summary: "Fix the login",
    description: null,
    status: { name: status, statusCategory: { key: "indeterminate" } },
    issuetype: { name: "Task" },
    labels: [],
    updated: "2026-11-14T10:30:00.000+0000",
  },
});

const statusItem = (from: string | null, to: string) => ({
  field: "status",
  fieldtype: "jira",
  fieldId: "status",
  from: "1",
  fromString: from,
  to: "2",
  toString: to,
});

describe("parseJiraDelivery", () => {
  // #1039-T01
  it("reads a status change from the changelog of an update", () => {
    const change = parseJiraDelivery(
      {
        timestamp: 1763116200000,
        webhookEvent: "jira:issue_updated",
        user: { accountId: "acc-9", displayName: "Grace" },
        issue: issue("Ready for agent"),
        changelog: {
          id: "1",
          items: [
            { field: "summary", fromString: "a", toString: "b" },
            statusItem("To Do", "Ready for agent"),
          ],
        },
        matchedWebhookIds: [1000],
      },
      SITE,
    );
    expect(change).toMatchObject({
      kind: "issue_changed",
      event: "updated",
      status: { from: "To Do", to: "Ready for agent" },
      actor: { accountId: "acc-9", name: "Grace" },
      matchedWebhookIds: [1000],
      issue: { key: "PROJ-7", status: "Ready for agent", number: 7 },
    });
  });

  // #1058-T01
  it("keeps the ids of the two statuses next to their names, and the id of the issue's status", () => {
    const change = parseJiraDelivery(
      {
        webhookEvent: "jira:issue_updated",
        issue: {
          ...issue("To Do"),
          fields: {
            ...issue("To Do").fields,
            status: { id: "10100", name: "To Do" },
          },
        },
        changelog: { items: [statusItem("In Progress", "To Do")] },
      },
      SITE,
    );
    expect(change).toMatchObject({
      status: { from: "In Progress", to: "To Do", fromId: "1", toId: "2" },
      issue: { status: "To Do", statusId: "10100" },
    });
  });

  // #1058
  it("takes no id for the new status from the payload issue when the item has none: the issue may have moved on since", () => {
    const change = parseJiraDelivery(
      {
        webhookEvent: "jira:issue_updated",
        issue: {
          ...issue("Done"),
          fields: {
            ...issue("Done").fields,
            status: { id: "3", name: "Done" },
          },
        },
        changelog: {
          items: [{ field: "status", fromString: "To Do", toString: "Ready" }],
        },
      },
      SITE,
    );
    expect(change).toMatchObject({ status: { from: "To Do", to: "Ready" } });
    expect(change).not.toHaveProperty("status.toId");
  });

  // #1039
  it("reads an update without a status item as a change of the issue only", () => {
    const change = parseJiraDelivery(
      {
        timestamp: 1,
        webhookEvent: "jira:issue_updated",
        issue: issue(),
        changelog: { items: [{ field: "labels", toString: "x" }] },
      },
      SITE,
    );
    expect(change).toMatchObject({ kind: "issue_changed", event: "updated" });
    expect(change).not.toHaveProperty("status");
  });

  // #1039
  it("reads a created issue as a change that has no status move", () => {
    const change = parseJiraDelivery(
      { timestamp: 1, webhookEvent: "jira:issue_created", issue: issue() },
      SITE,
    );
    expect(change).toMatchObject({ kind: "issue_changed", event: "created" });
    expect(change).not.toHaveProperty("status");
  });

  // #1039
  it("reads a deleted issue with the time of the deletion", () => {
    expect(
      parseJiraDelivery(
        {
          timestamp: 1763116200000,
          webhookEvent: "jira:issue_deleted",
          issue: issue(),
        },
        SITE,
      ),
    ).toEqual({
      kind: "issue_deleted",
      key: "PROJ-7",
      at: "2025-11-14T10:30:00.000Z",
      matchedWebhookIds: [],
    });
  });

  // #1039
  it("reads a comment as a change of its issue", () => {
    const change = parseJiraDelivery(
      {
        timestamp: 1,
        webhookEvent: "comment_created",
        comment: { id: "5", body: "hi" },
        issue: issue(),
      },
      SITE,
    );
    expect(change).toMatchObject({ kind: "issue_changed", event: "commented" });
  });

  // #1040-T03
  it("reads the text, the author and the time of a comment, whether Jira sends it as ADF or as text", () => {
    const adf = {
      version: 1,
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "/answer 2" }] },
      ],
    };
    const read = (body: unknown) =>
      parseJiraDelivery(
        {
          timestamp: 1,
          webhookEvent: "comment_created",
          comment: {
            id: "20001",
            body,
            author: {
              accountId: "acc-1",
              displayName: "Ada",
              accountType: "atlassian",
            },
            created: "2026-11-14T10:30:00.000+0100",
          },
          issue: issue(),
        },
        SITE,
      );
    for (const body of [adf, "/answer 2"])
      expect(read(body)).toMatchObject({
        kind: "issue_changed",
        event: "commented",
        comment: {
          id: "20001",
          text: "/answer 2",
          author: { accountId: "acc-1", name: "Ada", accountType: "atlassian" },
          createdAt: "2026-11-14T09:30:00.000Z",
        },
      });
    // A payload without an id, or a body that is neither, gives no comment; the issue is still read.
    const bare = parseJiraDelivery(
      {
        timestamp: 1,
        webhookEvent: "comment_created",
        comment: { body: "x" },
        issue: issue(),
      },
      SITE,
    );
    expect(bare).toMatchObject({ kind: "issue_changed" });
    expect("comment" in bare).toBe(false);
    expect(read(42)).toMatchObject({ comment: { text: "" } });
  });

  // #1040-T03
  it("bounds the text of a comment and reads it as data, whatever it holds", () => {
    const change = parseJiraDelivery(
      {
        timestamp: 1,
        webhookEvent: "comment_created",
        comment: { id: "1", body: "x".repeat(50_000) },
        issue: issue(),
      },
      SITE,
    );
    expect(change.kind === "issue_changed" && change.comment?.text.length).toBe(
      20_000,
    );
  });

  // #1039
  it("ignores an event the factory does not follow and a payload that is none", () => {
    for (const body of [
      { webhookEvent: "sprint_started", timestamp: 1 },
      { webhookEvent: "jira:version_released" },
      { timestamp: 1 },
      "text",
      null,
      { webhookEvent: "jira:issue_updated", timestamp: 1, issue: { id: "x" } },
    ])
      expect(parseJiraDelivery(body, SITE)).toMatchObject({ kind: "ignored" });
  });
});
