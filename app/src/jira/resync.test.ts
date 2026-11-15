// SPDX-License-Identifier: LicenseRef-Proprietary

// The full read of a Jira project into the ticket mirror (#1040): paged by the JQL search, resumable, and the rebuild rule (what Jira no
// longer has goes). The search and the clock are stand-ins; the mirror and the repository are the real code over the in-memory repository.
import { describe, expect, it } from "vitest";
import { createFakeTrackerRepository } from "../tracker/fake-tracker-repository.ts";
import type { JiraIssuePage, JiraIssueSearch } from "./issue-search.ts";
import type { JiraIssue } from "./issue.ts";
import { createJiraMirror } from "./mirror.ts";
import { JiraSyncError, createJiraResync } from "./resync.ts";

const issue = (number: number, over: Partial<JiraIssue> = {}): JiraIssue => ({
  id: String(10_000 + number),
  key: `PROJ-${String(number)}`,
  projectKey: "PROJ",
  number,
  title: `Issue ${String(number)}`,
  body: "",
  status: "To Do",
  statusCategory: "new",
  type: "Task",
  assignees: [],
  labels: [],
  url: `https://acme.atlassian.net/browse/PROJ-${String(number)}`,
  updatedAt: "2026-11-14T10:00:00.000Z",
  ...over,
});

const TARGET = {
  repositoryId: "repo-1",
  repoFullName: "acme/shop",
  connectionId: "conn-1",
  projectKey: "PROJ",
};

function setup(pages: JiraIssuePage[]) {
  let at = Date.parse("2026-11-14T12:00:00.000Z");
  const now = () => new Date(at);
  const tracker = createFakeTrackerRepository(now);
  const asked: (string | undefined)[] = [];
  const search: JiraIssueSearch = {
    async page(_connection, _key, after) {
      asked.push(after);
      const index = after === undefined ? 0 : Number(after);
      return pages[index] ?? { ok: true, issues: [], skipped: 0 };
    },
  };
  const resync = createJiraResync({
    tracker,
    search,
    mirror: createJiraMirror({ tracker, now }),
    now,
    warn: () => undefined,
  });
  return {
    tracker,
    resync,
    asked,
    tick: (ms: number) => void (at += ms),
  };
}

const page = (numbers: number[], next?: string): JiraIssuePage => ({
  ok: true,
  issues: numbers.map((n) => issue(n)),
  skipped: 0,
  ...(next === undefined ? {} : { next }),
});

describe("the full read of a Jira project", () => {
  // #1040-T04
  it("writes every issue of every page into the mirror and ends with the time of the full read", async () => {
    const { tracker, resync, asked } = setup([
      page([1, 2], "1"),
      page([3, 4], "2"),
      page([5]),
    ]);

    const progress = await resync.run(TARGET);

    expect(progress).toMatchObject({ status: "done", written: 5, removed: 0 });
    expect(asked).toEqual([undefined, "1", "2"]);
    expect(tracker.rows().map((row) => row.key)).toEqual([
      "PROJ-1",
      "PROJ-2",
      "PROJ-3",
      "PROJ-4",
      "PROJ-5",
    ]);
    expect(tracker.rows()[0]).toMatchObject({
      provider: "jira",
      repo: "acme/shop",
      boardStatus: "To Do",
    });
    const state = await tracker.getSyncState("repo-1", "jira");
    expect(state?.cursor).toBeNull();
    expect(state?.lastFullSyncAt).not.toBeNull();
  });

  // #1040-T04
  it("rebuilds the mirror: an issue Jira no longer has (deleted, or moved out of the project) is removed, one it still has stays", async () => {
    const { tracker, resync, tick } = setup([page([1, 2, 3])]);
    await resync.run(TARGET);
    tick(60_000);
    const second = setup([page([1, 3])]);
    // The same repository, read again: the second world starts with the rows of the first.
    for (const row of tracker.rows())
      await second.tracker.upsertItem("repo-1", {
        provider: "jira",
        repo: row.repo,
        key: row.key,
        number: row.number,
        nodeId: row.nodeId,
        kind: "issue",
        state: row.state,
        stateReason: null,
        type: row.type,
        title: row.title,
        bodyExcerpt: "",
        labels: [],
        assignees: [],
        closes: [],
        updatedAt: row.updatedAt,
      });
    second.tick(60_000);

    const progress = await second.resync.run(TARGET);

    expect(progress).toMatchObject({ status: "done", removed: 1 });
    expect(second.tracker.rows().map((row) => row.key)).toEqual([
      "PROJ-1",
      "PROJ-3",
    ]);
  });

  // #1040-T04
  it("stops at its page limit and continues with the next call where it stopped; the rebuild waits for the last page", async () => {
    const { tracker, resync, asked } = setup([
      page([1], "1"),
      page([2], "2"),
      page([3]),
    ]);

    const first = await resync.run(TARGET, { maxPages: 2 });
    expect(first).toMatchObject({ status: "partial", next: "issues" });
    expect(asked).toEqual([undefined, "1"]);
    expect(
      (await tracker.getSyncState("repo-1", "jira"))?.cursor,
    ).not.toBeNull();

    const second = await resync.run(TARGET);
    expect(second).toMatchObject({ status: "done" });
    // The second call went on at the page after the last one read, not from the start.
    expect(asked).toEqual([undefined, "1", "2"]);
    expect(tracker.rows()).toHaveLength(3);
  });

  // #1040-T04
  it("starts again from the first page when the sync has not moved for an hour, but a nightly call that resumes still continues it", async () => {
    const { resync, asked, tick } = setup([page([1], "1"), page([2])]);
    await resync.run(TARGET, { maxPages: 1 });
    tick(2 * 60 * 60 * 1000);
    await resync.run(TARGET, { resume: true, maxPages: 1 });
    expect(asked).toEqual([undefined, "1"]);

    const stale = setup([page([1], "1"), page([2])]);
    await stale.resync.run(TARGET, { maxPages: 1 });
    stale.tick(2 * 60 * 60 * 1000);
    await stale.resync.run(TARGET, { maxPages: 1 });
    expect(stale.asked).toEqual([undefined, undefined]);
  });

  // #1040-T04
  it("keeps the position when Jira cannot be asked, throws the code and nothing else, and removes nothing", async () => {
    const { tracker, resync } = setup([
      page([1], "1"),
      { ok: false, error: "jira_unavailable" },
    ]);

    await expect(resync.run(TARGET)).rejects.toMatchObject({
      name: "JiraSyncError",
      providerCode: "jira_unavailable",
    });
    await expect(resync.run(TARGET)).rejects.toBeInstanceOf(JiraSyncError);
    expect(tracker.rows()).toHaveLength(1);
    expect(
      (await tracker.getSyncState("repo-1", "jira"))?.cursor,
    ).not.toBeNull();
  });

  // #1040-T04
  it("removes nothing when an entry of a page could not be read", async () => {
    const { tracker, resync } = setup([
      { ok: true, issues: [issue(1)], skipped: 1 },
    ]);
    await tracker.upsertItem("repo-1", {
      provider: "jira",
      repo: "acme/shop",
      key: "PROJ-9",
      number: 9,
      nodeId: "jira:9",
      kind: "issue",
      state: "open",
      stateReason: null,
      type: null,
      title: "Old",
      bodyExcerpt: "",
      labels: [],
      assignees: [],
      closes: [],
      updatedAt: "2026-11-01T10:00:00.000Z",
    });

    const progress = await resync.run(TARGET);

    expect(progress).toMatchObject({ status: "done", removed: 0, skipped: 1 });
    expect(tracker.rows().map((row) => row.key)).toContain("PROJ-9");
  });
});
