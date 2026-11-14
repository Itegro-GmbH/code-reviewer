// SPDX-License-Identifier: LicenseRef-Proprietary

// What a Jira delivery does to the ticket mirror (#1039): the issue is written under the code repository with `provider = jira`, mapped to
// the neutral fields; a deleted issue becomes a tombstone; an older delivery changes nothing.
import { describe, expect, it } from "vitest";
import { createFakeTrackerRepository } from "../tracker/fake-tracker-repository.ts";
import { createJiraMirror } from "./mirror.ts";
import type { JiraChange } from "./webhook-events.ts";
import type { JiraIssue } from "./issue.ts";

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
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
  labels: ["backend"],
  parentKey: "PROJ-1",
  url: "https://acme.atlassian.net/browse/PROJ-7",
  updatedAt: "2026-11-14T10:00:00.000Z",
  ...over,
});

const changed = (i: JiraIssue): JiraChange => ({
  kind: "issue_changed",
  event: "updated",
  issue: i,
  matchedWebhookIds: [],
});

const TARGET = { repositoryId: "repo-1", repoFullName: "acme/widgets" };

function setup() {
  const tracker = createFakeTrackerRepository();
  return { tracker, mirror: createJiraMirror({ tracker }) };
}

describe("the Jira mirror", () => {
  // #1039-T01
  it("writes the issue under the code repository with the neutral fields", async () => {
    const { tracker, mirror } = setup();
    expect(await mirror.apply(TARGET, changed(issue()))).toBe("updated");
    const row = await tracker.getItem("repo-1", 7);
    expect(row).toMatchObject({
      provider: "jira",
      repo: "acme/widgets",
      key: "PROJ-7",
      number: 7,
      kind: "issue",
      state: "open",
      type: "Bug",
      title: "Fix the login",
      bodyExcerpt: "It fails.",
      boardStatus: "Ready for agent",
      labels: [{ name: "backend", color: "" }],
      assignees: [{ login: "Ada Lovelace" }],
      parentNumber: 1,
      nodeId: "jira:10042",
    });
  });

  // #1039
  it("shows a done status as closed and a parent of another project as none", async () => {
    const { tracker, mirror } = setup();
    await mirror.apply(
      TARGET,
      changed(
        issue({
          statusCategory: "done",
          status: "Done",
          parentKey: "OTHER-3",
          type: "",
        }),
      ),
    );
    expect(await tracker.getItem("repo-1", 7)).toMatchObject({
      state: "closed",
      boardStatus: "Done",
      parentNumber: null,
      type: null,
    });
  });

  // #1039
  it("cuts a title and a description that are longer than the mirror keeps", async () => {
    const { tracker, mirror } = setup();
    await mirror.apply(
      TARGET,
      changed(issue({ title: "t".repeat(2000), body: "b".repeat(9000) })),
    );
    const row = await tracker.getItem("repo-1", 7);
    expect(row?.title.length).toBeLessThanOrEqual(1024);
    expect(row?.bodyExcerpt.length).toBeLessThanOrEqual(4096);
  });

  // #1039
  it("keeps what a newer delivery said when an older one comes late", async () => {
    const { tracker, mirror } = setup();
    await mirror.apply(
      TARGET,
      changed(issue({ title: "new", updatedAt: "2026-11-14T11:00:00.000Z" })),
    );
    expect(
      await mirror.apply(
        TARGET,
        changed(issue({ title: "old", updatedAt: "2026-11-14T09:00:00.000Z" })),
      ),
    ).toBe("not_mirrored");
    expect((await tracker.getItem("repo-1", 7))?.title).toBe("new");
  });

  // #1039
  it("hides a deleted issue and does not bring it back for an older delivery", async () => {
    const { tracker, mirror } = setup();
    await mirror.apply(TARGET, changed(issue()));
    expect(
      await mirror.apply(TARGET, {
        kind: "issue_deleted",
        key: "PROJ-7",
        at: "2026-11-14T12:00:00.000Z",
        matchedWebhookIds: [],
      }),
    ).toBe("updated");
    expect(await tracker.getItem("repo-1", 7)).toBeUndefined();
    await mirror.apply(
      TARGET,
      changed(issue({ updatedAt: "2026-11-14T10:30:00.000Z" })),
    );
    expect(await tracker.getItem("repo-1", 7)).toBeUndefined();
  });

  // #1039
  it("answers not mirrored for a deletion of an issue it does not hold, an ignored delivery and a key that is none", async () => {
    const { mirror } = setup();
    expect(
      await mirror.apply(TARGET, {
        kind: "issue_deleted",
        key: "PROJ-99",
        at: "2026-11-14T12:00:00.000Z",
        matchedWebhookIds: [],
      }),
    ).toBe("not_mirrored");
    expect(await mirror.apply(TARGET, { kind: "ignored", reason: "x" })).toBe(
      "not_mirrored",
    );
  });
});

describe("clearing the rows of another provider", () => {
  // #1039
  it("removes the GitHub rows of a repository whose tickets became a Jira project, and keeps the Jira rows", async () => {
    const { tracker, mirror } = setup();
    await tracker.upsertItem("repo-1", {
      provider: "github",
      repo: "acme/widgets",
      number: 7,
      nodeId: "gh-node",
      kind: "issue",
      state: "open",
      stateReason: null,
      type: null,
      title: "GitHub issue",
      bodyExcerpt: "",
      labels: [],
      assignees: [],
      closes: [],
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(await tracker.clearOtherProviders("repo-1", "jira")).toBe(1);
    expect(await tracker.getItem("repo-1", 7)).toBeUndefined();
    await mirror.apply(TARGET, changed(issue()));
    expect(await tracker.clearOtherProviders("repo-1", "jira")).toBe(0);
    expect(await tracker.getItem("repo-1", 7)).toMatchObject({
      provider: "jira",
    });
  });
});
