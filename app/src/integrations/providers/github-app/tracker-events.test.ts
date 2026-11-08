// SPDX-License-Identifier: LicenseRef-Proprietary

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { webhookFixture } from "../../../../../fakes/github/webhooks.ts";
import { parseTrackerChange } from "./tracker-events.ts";
import {
  isTrackerWebhookEvent,
  isReadWebhookEvent,
  specProblems,
  TRACKER_WEBHOOK_FIELDS,
} from "./webhook-fields.ts";

const parse = (name: string, eventName = name.split(".")[0] as string) =>
  parseTrackerChange({
    integrationId: "i-1",
    eventName,
    payload: webhookFixture(name),
  });

const REPO = {
  integrationId: "i-1",
  externalId: "7001",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
};

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../fakes/fixtures/github-webhooks",
);

describe("the recorded payloads of the events the ticket mirror reads", () => {
  // #923-T10
  it("have every field the mirror reads, with the right type", () => {
    const names = readdirSync(FIXTURES)
      .map((file) => file.replace(/\.json$/, ""))
      .filter((name) => {
        const event = name.split(".")[0] as string;
        // The events only the mirror reads, and the payloads written for it: the older payloads are reduced to what the reviews read.
        return (
          isTrackerWebhookEvent(event) &&
          (!isReadWebhookEvent(event) || name.includes(".mirror"))
        );
      });

    expect(names.length).toBeGreaterThan(8);
    for (const name of names)
      expect(
        specProblems(
          TRACKER_WEBHOOK_FIELDS[
            name.split(".")[0] as keyof typeof TRACKER_WEBHOOK_FIELDS
          ],
          webhookFixture(name),
        ),
        name,
      ).toEqual([]);
  });
});

describe("what a delivery says about the ticket mirror", () => {
  // #923-T11
  it("writes the issue of every action of `issues` as GitHub delivers it", () => {
    const result = parse("issues.edited.mirror");

    expect(result).toEqual({
      kind: "change",
      change: {
        kind: "item_changed",
        repo: REPO,
        resetChecks: false,
        item: expect.objectContaining({
          number: 12,
          nodeId: "I_kwDOAAA12",
          kind: "issue",
          state: "open",
          type: "Task",
          parentNumber: 3,
          labels: [
            { name: "enhancement", color: "a2eeef" },
            { name: "ready for agent", color: "0e8a16" },
          ],
          assignees: [{ login: "alice" }],
        }),
      },
    });
  });

  // #923-T12
  it("keeps the reason of a closed issue, and removes a deleted one", () => {
    expect(parse("issues.closed.mirror")).toMatchObject({
      change: { item: { state: "closed", stateReason: "completed" } },
    });
    expect(parse("issues.deleted.mirror")).toEqual({
      kind: "change",
      change: {
        kind: "item_removed",
        repo: REPO,
        number: 12,
        at: "2026-11-06T10:00:00.000Z",
      },
    });
  });

  // #923-T13
  it("writes a pull request that merged, with the issues it closes, and clears the checks of a new commit only", () => {
    expect(parse("pull_request.closed.merged.mirror")).toMatchObject({
      change: {
        kind: "item_changed",
        resetChecks: false,
        item: {
          number: 7,
          kind: "pull_request",
          state: "closed",
          stateReason: "merged",
          closes: [12, 13],
        },
      },
    });
    expect(parse("pull_request.synchronize.mirror")).toMatchObject({
      change: { resetChecks: true, item: { state: "open", stateReason: null } },
    });
    expect(parse("pull_request.review_requested.mirror")).toMatchObject({
      change: { resetChecks: false },
    });
    // #924-T01: the object carries the whole list of who is asked; the other deliveries carry none and say nothing about it
    expect(parse("pull_request.review_requested.mirror")).toMatchObject({
      change: { item: { reviewRequestedFrom: ["carol"] } },
    });
    expect(parse("pull_request.synchronize.mirror")).toMatchObject({
      change: { item: { number: 7 } },
    });
    const synchronized = parse("pull_request.synchronize.mirror");
    expect(
      synchronized.kind === "change" &&
        synchronized.change.kind === "item_changed" &&
        "reviewRequestedFrom" in synchronized.change.item,
    ).toBe(false);
  });

  // #923-T14
  it("refreshes the issue of a comment, and takes nothing from a deleted comment", () => {
    expect(parse("issue_comment.created.mirror")).toMatchObject({
      change: {
        kind: "item_changed",
        item: { number: 12, updatedAt: "2026-11-06T13:00:00.000Z" },
      },
    });
    const deleted = webhookFixture("issue_comment.created.mirror");
    expect(
      parseTrackerChange({
        integrationId: "i-1",
        eventName: "issue_comment",
        payload: { ...deleted, action: "deleted" },
      }),
    ).toMatchObject({ kind: "ignored" });
  });

  // #923-T15
  it("sets a parent when a sub-issue is added and empties it when it is removed", () => {
    expect(parse("sub_issues.sub_issue_added")).toEqual({
      kind: "change",
      change: {
        kind: "parent_changed",
        repo: REPO,
        child: 12,
        parent: 3,
        at: "2026-11-06T10:00:00.000Z",
      },
    });
    expect(parse("sub_issues.parent_issue_removed")).toEqual({
      kind: "change",
      change: {
        kind: "parent_changed",
        repo: REPO,
        child: 12,
        parent: null,
        at: "2026-11-06T10:00:00.000Z",
      },
    });
  });

  // #923-R29
  it("needs the time of the issue to order a deletion or a parent change against the other deliveries", () => {
    const parse = (eventName: string, payload: unknown) =>
      parseTrackerChange({ integrationId: "i-1", eventName, payload });
    const deleted = webhookFixture("issues.deleted.mirror") as {
      issue: Record<string, unknown>;
    };
    const added = webhookFixture("sub_issues.sub_issue_added") as {
      sub_issue: Record<string, unknown>;
    };

    expect(
      parse("issues", {
        ...deleted,
        issue: { ...deleted.issue, updated_at: "later" },
      }),
    ).toMatchObject({ kind: "invalid_payload" });
    expect(
      parse("sub_issues", {
        ...added,
        sub_issue: { ...added.sub_issue, updated_at: "later" },
      }),
    ).toMatchObject({ kind: "invalid_payload" });
    const { updated_at: _removed, ...withoutTime } = added.sub_issue;
    void _removed;
    expect(
      parse("sub_issues", { ...added, sub_issue: withoutTime }),
    ).toMatchObject({ kind: "invalid_payload" });
  });

  // #923-T16
  it("ignores a sub-issue in another repository than its parent", () => {
    const payload = {
      ...webhookFixture("sub_issues.sub_issue_added"),
      sub_issue_repo: { full_name: "acme/other" },
    };

    expect(
      parseTrackerChange({
        integrationId: "i-1",
        eventName: "sub_issues",
        payload,
      }),
    ).toMatchObject({ kind: "ignored" });
  });

  // #923-T17
  it("sets the board status of an item from the Status field", () => {
    expect(parse("projects_v2_item.edited")).toEqual({
      kind: "change",
      change: {
        kind: "board_status_changed",
        nodeId: "I_kwDOAAA12",
        status: "In Progress",
      },
    });
    expect(
      parse("projects_v2_item.edited.other-field", "projects_v2_item"),
    ).toMatchObject({
      kind: "ignored",
    });
  });

  // #932-T06
  it.each([
    ["created", false],
    ["restored", false],
    ["archived", true],
    ["deleted", true],
  ])(
    "asks for the status again when a board item is %s: the delivery names none, and the ticket may be on other boards",
    (action, removed) => {
      expect(
        parseTrackerChange({
          integrationId: "i-1",
          eventName: "projects_v2_item",
          payload: {
            ...(webhookFixture("projects_v2_item.deleted") as object),
            action,
          },
        }),
      ).toEqual({
        kind: "change",
        change: { kind: "board_item_reread", nodeId: "I_kwDOAAA12", removed },
      });
    },
  );

  // #932-T07
  it("ignores the board item actions that carry no status and move no ticket", () => {
    expect(
      parseTrackerChange({
        integrationId: "i-1",
        eventName: "projects_v2_item",
        payload: {
          ...(webhookFixture("projects_v2_item.deleted") as object),
          action: "reordered",
        },
      }),
    ).toMatchObject({ kind: "ignored" });
  });

  // #923-T18
  it("names the pull requests of a check suite, and ignores a suite that has none", () => {
    expect(parse("check_suite.completed")).toEqual({
      kind: "change",
      change: {
        kind: "checks_changed",
        repo: REPO,
        headSha: "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01",
        pullRequests: [7],
      },
    });
    expect(
      parse("check_suite.completed.no-pull-request", "check_suite"),
    ).toMatchObject({
      kind: "ignored",
    });
  });

  // #923-T19
  it("names the fields of a payload that lacks them, never their values", () => {
    const payload = webhookFixture("check_suite.completed") as Record<
      string,
      unknown
    >;
    const without = { ...payload };
    delete without.repository;

    expect(
      parseTrackerChange({
        integrationId: "i-1",
        eventName: "check_suite",
        payload: without,
      }),
    ).toEqual({
      kind: "invalid_payload",
      reason: expect.stringContaining("repository.id"),
    });
    expect(
      parseTrackerChange({
        integrationId: "i-1",
        eventName: "issues",
        payload: {
          ...webhookFixture("issues.edited.mirror"),
          issue: { number: 3, node_id: "x", updated_at: "now" },
        },
      }),
    ).toMatchObject({ kind: "invalid_payload" });
  });

  // #923-T20
  it("is none of the business of an event it does not follow", () => {
    expect(
      parseTrackerChange({
        integrationId: "i-1",
        eventName: "push",
        payload: {},
      }),
    ).toEqual({
      kind: "ignored",
      reason: 'the event "push" is not used by the ticket mirror',
    });
  });
});
