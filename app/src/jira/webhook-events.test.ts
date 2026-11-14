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
  it("notes the old key when the key of the issue changed", () => {
    const change = parseJiraDelivery(
      {
        timestamp: 1,
        webhookEvent: "jira:issue_updated",
        issue: issue("To Do", "NEW-3"),
        changelog: {
          items: [{ field: "Key", fromString: "OLD-5", toString: "NEW-3" }],
        },
      },
      SITE,
    );
    expect(change).toMatchObject({ kind: "issue_changed", keyFrom: "OLD-5" });
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
