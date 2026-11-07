// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the ticket mirror's tables against a real Postgres database (#923): a ticket written again keeps what other deliveries said,
// the pull requests of an issue are computed from the `closes` of the pull requests, a board item is found by its node id, rows not written
// since a time are removed, and the state of a sync is kept per repository. The rules without SQL are proved in `src/tracker/` against
// an in-memory repository that has to behave the same.
import { describe, expect, it } from "vitest";
import type { RepoRef } from "../../integrations/types.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";
import { createIntegrationsRepository } from "./integrations-repository.ts";
import { createProjectsRepository } from "./projects-repository.ts";
import { createRepositoriesRepository } from "./repositories-repository.ts";
import {
  createTrackerRepository,
  type TrackerItemWrite,
} from "./tracker-repository.ts";

async function setup() {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 6, 12, 0, tick++));
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
    now,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const remote = (id: number): RepoRef => ({
    integrationId: integration.id,
    externalId: String(id),
    fullName: `acme/repo-${id}`,
    url: `https://github.test/acme/repo-${id}`,
  });
  const repositories = createRepositoriesRepository(db, workspaceId, now);
  await repositories.reconcile(integration.id, [remote(1), remote(2)]);
  const [first, second] = await repositories.list();
  if (first === undefined || second === undefined)
    throw new Error("seeding failed");
  return {
    db,
    first,
    second,
    tracker: createTrackerRepository(db, workspaceId, { now }),
    workspaceId,
    now,
  };
}

const item = (
  number: number,
  overrides: Partial<TrackerItemWrite> = {},
): TrackerItemWrite => ({
  provider: "github",
  repo: "acme/repo-1",
  number,
  nodeId: `N_${number}`,
  kind: "issue",
  state: "open",
  stateReason: null,
  type: null,
  title: `Ticket ${number}`,
  bodyExcerpt: "",
  labels: [],
  assignees: [],
  closes: [],
  updatedAt: `2026-11-06T10:0${number % 10}:00.000Z`,
  ...overrides,
});

describe("the tickets of the mirror", () => {
  // #923-T87
  it("stores a ticket as it is delivered and reads it back", async () => {
    const { tracker, first } = await setup();

    await tracker.upsertItem(
      first.id,
      item(12, {
        type: "Task",
        labels: [{ name: "ready", color: "0e8a16" }],
        assignees: [{ login: "alice" }],
        parentNumber: 3,
        bodyExcerpt: "The widget list.",
      }),
    );

    expect(await tracker.getItem(first.id, 12)).toEqual({
      repositoryId: first.id,
      projectId: null,
      provider: "github",
      repo: "acme/repo-1",
      number: 12,
      nodeId: "N_12",
      kind: "issue",
      state: "open",
      stateReason: null,
      type: "Task",
      title: "Ticket 12",
      bodyExcerpt: "The widget list.",
      labels: [{ name: "ready", color: "0e8a16" }],
      assignees: [{ login: "alice" }],
      boardStatus: null,
      parentNumber: 3,
      pullRequests: [],
      closes: [],
      checksState: null,
      updatedAt: "2026-11-06T10:02:00.000Z",
      syncedAt: expect.any(String),
    });
  });

  // #923-T88
  it("replaces what the provider says and keeps the board status, the pull requests and the checks", async () => {
    const { tracker, first } = await setup();
    await tracker.upsertItem(first.id, item(12, { parentNumber: 3 }));
    await tracker.upsertItem(
      first.id,
      item(7, { kind: "pull_request", closes: [12] }),
    );
    await tracker.setBoardStatusByNode("N_12", "Todo");
    await tracker.setChecksState(first.id, 7, "success");
    await tracker.linkPullRequests(first.id);

    await tracker.upsertItem(
      first.id,
      item(12, { title: "Renamed", state: "closed", stateReason: "completed" }),
    );
    await tracker.upsertItem(
      first.id,
      item(7, { kind: "pull_request", closes: [12], title: "Renamed too" }),
    );

    expect(await tracker.getItem(first.id, 12)).toMatchObject({
      title: "Renamed",
      state: "closed",
      stateReason: "completed",
      boardStatus: "Todo",
      parentNumber: 3,
      pullRequests: [7],
    });
    expect(await tracker.getItem(first.id, 7)).toMatchObject({
      title: "Renamed too",
      checksState: "success",
    });
  });

  // #923-T89
  it("sets the parent when a delivery names it, empties it for null, and leaves it when the delivery is silent", async () => {
    const { tracker, first } = await setup();
    await tracker.upsertItem(first.id, item(12, { parentNumber: 3 }));
    await tracker.upsertItem(first.id, item(12));
    expect((await tracker.getItem(first.id, 12))?.parentNumber).toBe(3);

    await tracker.upsertItem(first.id, item(12, { parentNumber: null }));

    expect((await tracker.getItem(first.id, 12))?.parentNumber).toBeNull();
    const later = "2026-11-06T10:05:00.000Z";
    expect(await tracker.setParent(first.id, 12, 5, later)).toBe(true);
    expect((await tracker.getItem(first.id, 12))?.parentNumber).toBe(5);
    expect(await tracker.setParent(first.id, 99, 5, later)).toBe(false);
  });

  // #923-T90
  it("lists the newest change first, by state and kind, a page at a time", async () => {
    const { tracker, first, second } = await setup();
    await tracker.upsertItem(first.id, item(1));
    await tracker.upsertItem(first.id, item(2, { state: "closed" }));
    await tracker.upsertItem(first.id, item(3, { kind: "pull_request" }));
    await tracker.upsertItem(
      first.id,
      item(4, { updatedAt: "2026-11-01T00:00:00.000Z" }),
    );
    await tracker.upsertItem(
      second.id,
      item(1, { repo: "acme/repo-2", nodeId: "N_other" }),
    );

    const numbers = async (filter: Parameters<typeof tracker.listItems>[1]) =>
      (await tracker.listItems(first.id, filter)).map((row) => row.number);

    expect(await numbers({ limit: 10 })).toEqual([3, 2, 1, 4]);
    expect(await numbers({ limit: 10, state: "open" })).toEqual([3, 1, 4]);
    expect(await numbers({ limit: 10, kind: "pull_request" })).toEqual([3]);
    expect(await numbers({ limit: 2, offset: 1 })).toEqual([2, 1]);
  });

  // #923-T91
  it("computes the pull requests of an issue from the issues the pull requests close", async () => {
    const { tracker, first } = await setup();
    await tracker.upsertItem(first.id, item(12));
    await tracker.upsertItem(first.id, item(13));
    await tracker.upsertItem(
      first.id,
      item(7, { kind: "pull_request", closes: [12, 13] }),
    );
    await tracker.upsertItem(
      first.id,
      item(8, { kind: "pull_request", closes: [12] }),
    );

    await tracker.linkPullRequests(first.id, [12]);
    expect((await tracker.getItem(first.id, 12))?.pullRequests).toEqual([7, 8]);
    expect((await tracker.getItem(first.id, 13))?.pullRequests).toEqual([]);

    await tracker.linkPullRequests(first.id);
    expect((await tracker.getItem(first.id, 13))?.pullRequests).toEqual([7]);

    await tracker.upsertItem(
      first.id,
      item(7, { kind: "pull_request", closes: [13] }),
    );
    await tracker.linkPullRequests(first.id, [12, 13]);
    expect((await tracker.getItem(first.id, 12))?.pullRequests).toEqual([8]);
    // A pull request is never listed on a pull request, and nothing is done for no issue at all.
    expect((await tracker.getItem(first.id, 8))?.pullRequests).toEqual([]);
    await tracker.linkPullRequests(first.id, []);
  });

  // #923-T92
  it("does not list the pull requests of another repository on an issue", async () => {
    const { tracker, first, second } = await setup();
    await tracker.upsertItem(first.id, item(12));
    await tracker.upsertItem(
      second.id,
      item(7, {
        repo: "acme/repo-2",
        nodeId: "N_p",
        kind: "pull_request",
        closes: [12],
      }),
    );

    await tracker.linkPullRequests(first.id);

    expect((await tracker.getItem(first.id, 12))?.pullRequests).toEqual([]);
  });

  // #923-T93
  it("finds the item of a board by the node id of its content, and forgets the statuses no board said anything about since a time", async () => {
    const { tracker, first, second, now } = await setup();
    await tracker.upsertItem(first.id, item(12));
    await tracker.upsertItem(first.id, item(13));
    await tracker.upsertItem(
      second.id,
      item(12, { repo: "acme/repo-2", nodeId: "N_other" }),
    );
    await tracker.setBoardStatusByNode("N_other", "Done");
    await tracker.setBoardStatusByNode("N_13", "Todo");
    const since = now().toISOString();

    expect(await tracker.setBoardStatusByNode("N_12", "In Progress")).toBe(1);
    expect(await tracker.setBoardStatusByNode("N_unknown", "Done")).toBe(0);
    await tracker.clearBoardStatusesNotSeenSince(first.id, since);

    // 12 was seen after `since`; 13 was not; the other repository is not touched.
    expect((await tracker.getItem(first.id, 12))?.boardStatus).toBe(
      "In Progress",
    );
    expect((await tracker.getItem(first.id, 13))?.boardStatus).toBeNull();
    expect((await tracker.getItem(second.id, 12))?.boardStatus).toBe("Done");
  });

  // #932-T22
  it("finds a cached item by the node id in any repository of the workspace, never a tombstone", async () => {
    const { tracker, first, second } = await setup();
    await tracker.upsertItem(first.id, item(12));
    await tracker.upsertItem(
      second.id,
      item(5, { repo: "acme/repo-2", nodeId: "N_other" }),
    );

    expect(await tracker.findItemByNode("N_other")).toMatchObject({
      repositoryId: second.id,
      number: 5,
    });
    expect(await tracker.findItemByNode("N_unknown")).toBeUndefined();

    await tracker.deleteItem(first.id, 12, "2999-01-01T00:00:00.000Z");
    expect(await tracker.findItemByNode("N_12")).toBeUndefined();
  });

  // #932-T23
  it("says when the cache of a repository was last written: the newest row, a tombstone included, null for none", async () => {
    const { tracker, first, second } = await setup();
    expect(await tracker.newestWriteAt(first.id)).toBeNull();

    await tracker.upsertItem(first.id, item(12));
    const afterFirst = await tracker.newestWriteAt(first.id);
    await tracker.upsertItem(first.id, item(13));
    const afterSecond = await tracker.newestWriteAt(first.id);
    await tracker.deleteItem(first.id, 12, "2999-01-01T00:00:00.000Z");

    expect(afterFirst).not.toBeNull();
    expect(afterSecond && afterFirst && afterSecond > afterFirst).toBe(true);
    // Another repository's rows do not count.
    expect(await tracker.newestWriteAt(second.id)).toBeNull();
  });

  // #923-T94
  it("sets the checks of a pull request, and forgets those of what is not an open pull request", async () => {
    const { tracker, first } = await setup();
    await tracker.upsertItem(first.id, item(7, { kind: "pull_request" }));
    await tracker.upsertItem(
      first.id,
      item(8, { kind: "pull_request", state: "closed" }),
    );

    expect(await tracker.setChecksState(first.id, 7, "failure")).toBe(true);
    expect(await tracker.setChecksState(first.id, 8, "success")).toBe(true);
    await tracker.clearChecksStatesOfClosed(first.id);
    // #932: an open pull request keeps what the sync wrote; the sync wrote none for a pull request it did not read.
    expect((await tracker.getItem(first.id, 7))?.checksState).toBe("failure");
    expect((await tracker.getItem(first.id, 8))?.checksState).toBeNull();
    expect(await tracker.setChecksState(first.id, 99, "failure")).toBe(false);
  });

  // #923-T95
  it("hides a ticket, and removes the tickets not written since a time", async () => {
    const { tracker, first, now } = await setup();
    await tracker.upsertItem(first.id, item(1));
    await tracker.upsertItem(first.id, item(2));
    const cut = now().toISOString();
    await tracker.upsertItem(first.id, item(2, { title: "Written again" }));
    await tracker.upsertItem(first.id, item(3));

    expect(await tracker.removeNotWrittenSince(first.id, cut)).toBe(1);
    expect(
      (await tracker.listItems(first.id, { limit: 10, state: "open" }))
        .map((row) => row.number)
        .sort(),
    ).toEqual([2, 3]);
    expect(
      await tracker.deleteItem(first.id, 2, "2026-11-06T11:00:00.000Z"),
    ).toBe(true);
    expect(
      await tracker.deleteItem(first.id, 2, "2026-11-06T11:00:00.000Z"),
    ).toBe(false);
  });

  // #923-T96
  it("keeps the state of a sync per repository, and leaves the fields a write does not name", async () => {
    const { tracker, first, second } = await setup();
    expect(await tracker.getSyncState(first.id)).toBeUndefined();

    await tracker.saveSyncState(first.id, {
      cursor: '{"phase":"issues","page":2}',
      startedAt: "2026-11-06T09:00:00.000Z",
    });
    await tracker.saveSyncState(first.id, {
      lastFullSyncAt: "2026-11-05T09:00:00.000Z",
    });
    await tracker.saveSyncState(second.id, {
      cursor: '{"phase":"checks","page":1}',
    });

    expect(await tracker.getSyncState(first.id)).toEqual({
      repositoryId: first.id,
      projectId: null,
      cursor: '{"phase":"issues","page":2}',
      startedAt: "2026-11-06T09:00:00.000Z",
      lastFullSyncAt: "2026-11-05T09:00:00.000Z",
      updatedAt: expect.any(String),
    });

    await tracker.saveSyncState(first.id, { cursor: null, startedAt: null });
    expect(await tracker.getSyncState(first.id)).toMatchObject({
      cursor: null,
      startedAt: null,
      lastFullSyncAt: "2026-11-05T09:00:00.000Z",
    });
    expect((await tracker.getSyncState(second.id))?.cursor).toBe(
      '{"phase":"checks","page":1}',
    );
  });

  // #923-T97
  it("holds a ticket number once per repository and the same number in two", async () => {
    const { tracker, first, second, db } = await setup();
    await tracker.upsertItem(first.id, item(1));
    await tracker.upsertItem(
      second.id,
      item(1, { repo: "acme/repo-2", nodeId: "N_other" }),
    );
    await tracker.upsertItem(first.id, item(1, { title: "Once" }));

    const rows = await db
      .selectFrom("tracker_items")
      .select(["repository_id", "number", "title"])
      .execute();

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.repository_id === first.id)?.title).toBe(
      "Once",
    );
  });

  // #923-T98
  it("refuses a state, a kind or a number the table does not know", async () => {
    const { tracker, first } = await setup();

    await expect(
      tracker.upsertItem(first.id, item(1, { kind: "epic" as never })),
    ).rejects.toThrow();
    await expect(
      tracker.upsertItem(first.id, item(2, { state: "merged" as never })),
    ).rejects.toThrow();
    await expect(tracker.upsertItem(first.id, item(0))).rejects.toThrow();
  });
});

const T1 = "2026-11-06T11:00:01.000Z";
const T2 = "2026-11-06T11:00:02.000Z";
const T3 = "2026-11-06T11:00:03.000Z";

describe("deliveries that arrive out of order or twice", () => {
  // #923-R19
  it("drops a delivery older than the row, takes an equal or newer one, and still counts the row as written", async () => {
    const { tracker, first, now } = await setup();
    expect(
      await tracker.upsertItem(
        first.id,
        item(12, { title: "New", updatedAt: T2 }),
      ),
    ).toBe(true);
    const cut = now().toISOString();

    expect(
      await tracker.upsertItem(
        first.id,
        item(12, { title: "Old", updatedAt: T1 }),
      ),
    ).toBe(false);

    expect(await tracker.getItem(first.id, 12)).toMatchObject({
      title: "New",
      updatedAt: T2,
    });
    // The page of a full sync that was read before the newer delivery does not make the row look gone.
    expect(await tracker.removeNotWrittenSince(first.id, cut)).toBe(0);
    expect(
      await tracker.upsertItem(
        first.id,
        item(12, { title: "Same", updatedAt: T2 }),
      ),
    ).toBe(true);
    expect(
      await tracker.upsertItem(
        first.id,
        item(12, { title: "Next", updatedAt: T3 }),
      ),
    ).toBe(true);
    expect((await tracker.getItem(first.id, 12))?.title).toBe("Next");
  });

  // #923-R20
  it("keeps a stale pull request out and leaves its closes as they are", async () => {
    const { tracker, first } = await setup();
    await tracker.upsertItem(first.id, item(12));
    await tracker.upsertItem(
      first.id,
      item(7, { kind: "pull_request", closes: [12], updatedAt: T2 }),
    );

    await tracker.upsertItem(
      first.id,
      item(7, {
        kind: "pull_request",
        closes: [],
        state: "closed",
        updatedAt: T1,
      }),
    );
    await tracker.linkPullRequests(first.id, [12]);

    expect(await tracker.getItem(first.id, 7)).toMatchObject({
      state: "open",
      closes: [12],
    });
    expect((await tracker.getItem(first.id, 12))?.pullRequests).toEqual([7]);
  });

  // #923-R21
  it("drops a parent change older than the row, and an item delivery older than a parent change", async () => {
    const { tracker, first } = await setup();
    await tracker.upsertItem(first.id, item(12, { updatedAt: T1 }));

    expect(await tracker.setParent(first.id, 12, null, T3)).toBe(true);
    expect(await tracker.setParent(first.id, 12, 3, T2)).toBe(false);
    expect((await tracker.getItem(first.id, 12))?.parentNumber).toBeNull();

    expect(
      await tracker.setParent(first.id, 12, 5, "2026-11-06T11:00:04.000Z"),
    ).toBe(true);
    expect(
      await tracker.upsertItem(
        first.id,
        item(12, { parentNumber: 3, updatedAt: T3 }),
      ),
    ).toBe(false);
    expect((await tracker.getItem(first.id, 12))?.parentNumber).toBe(5);
  });

  // #923-R22
  it("keeps a deleted ticket as a tombstone: hidden everywhere, brought back only by a strictly newer delivery", async () => {
    const { tracker, first, now } = await setup();
    await tracker.upsertItem(first.id, item(12, { updatedAt: T1 }));
    await tracker.upsertItem(first.id, item(13, { updatedAt: T1 }));
    await tracker.setBoardStatusByNode("N_12", "Todo");

    expect(await tracker.deleteItem(first.id, 12, T2)).toBe(true);

    expect(await tracker.getItem(first.id, 12)).toBeUndefined();
    expect(
      (await tracker.listItems(first.id, { limit: 10 })).map(
        (row) => row.number,
      ),
    ).toEqual([13]);
    expect(await tracker.setBoardStatusByNode("N_12", "Done")).toBe(0);
    expect(await tracker.setChecksState(first.id, 12, "success")).toBe(false);
    expect(await tracker.setParent(first.id, 12, 3, T3)).toBe(false);
    // An edit from before the deletion, a replay of it and one at the very time of the deletion: the ticket stays gone.
    expect(
      await tracker.upsertItem(
        first.id,
        item(12, { title: "Late", updatedAt: T1 }),
      ),
    ).toBe(false);
    expect(
      await tracker.upsertItem(
        first.id,
        item(12, { title: "Same", updatedAt: T2 }),
      ),
    ).toBe(false);
    expect(await tracker.getItem(first.id, 12)).toBeUndefined();
    // The deletion itself is not applied twice, and not over a change that came after it.
    expect(await tracker.deleteItem(first.id, 12, T3)).toBe(false);
    expect(
      await tracker.deleteItem(first.id, 13, "2026-11-06T10:00:00.000Z"),
    ).toBe(false);
    // A full sync counts what it removes: the ticket that was not written, not the tombstone, which stays for the deliveries that are late.
    expect(
      await tracker.removeNotWrittenSince(first.id, now().toISOString()),
    ).toBe(1);
    expect(
      await tracker.upsertItem(
        first.id,
        item(12, { title: "Late again", updatedAt: T1 }),
      ),
    ).toBe(false);
    expect(
      await tracker.upsertItem(
        first.id,
        item(12, { title: "Back", updatedAt: T3 }),
      ),
    ).toBe(true);
    expect(await tracker.getItem(first.id, 12)).toMatchObject({
      title: "Back",
    });
  });

  // #923-R23
  it("forgets a tombstone only after it has been kept for a long time", async () => {
    const { tracker, first, db } = await setup();
    await tracker.upsertItem(first.id, item(12, { updatedAt: T1 }));
    await tracker.deleteItem(first.id, 12, T2);

    await tracker.removeNotWrittenSince(first.id, "2026-11-20T00:00:00.000Z");
    expect(
      await db.selectFrom("tracker_items").select("number").execute(),
    ).toHaveLength(1);

    await tracker.removeNotWrittenSince(first.id, "2027-03-01T00:00:00.000Z");
    expect(
      await db.selectFrom("tracker_items").select("number").execute(),
    ).toHaveLength(0);
  });
});

describe("the pull requests of many issues", () => {
  // #923-R24
  it("links hundreds of issues in one statement, writes only what changed, and leaves out deleted pull requests", async () => {
    const { tracker, first, db } = await setup();
    for (let number = 1; number <= 300; number += 1)
      await tracker.upsertItem(first.id, item(number));
    // 250 pull requests, numbered after the issues, each closing two issues; one of them is deleted.
    for (let n = 0; n < 250; n += 1)
      await tracker.upsertItem(
        first.id,
        item(1000 + n, {
          kind: "pull_request",
          closes: [n + 1, ((n + 1) % 300) + 1],
        }),
      );
    await tracker.deleteItem(first.id, 1000, "2026-11-06T23:00:00.000Z");

    await tracker.linkPullRequests(first.id);

    // Issue k is closed by the pull requests 1000 + k - 1 and 1000 + k - 2 (those that exist); 1000 is deleted.
    const listed = async (number: number) =>
      (await tracker.getItem(first.id, number))?.pullRequests;
    expect(await listed(1)).toEqual([]);
    expect(await listed(2)).toEqual([1001]);
    expect(await listed(3)).toEqual([1001, 1002]);
    expect(await listed(250)).toEqual([1248, 1249]);
    expect(await listed(251)).toEqual([1249]);
    expect(await listed(252)).toEqual([]);
    expect(await listed(300)).toEqual([]);
    // Nothing changed: not one row is written the second time.
    const before = await db
      .selectFrom("tracker_items")
      .select(["number", "synced_at"])
      .execute();
    await tracker.linkPullRequests(first.id);
    expect(
      await db
        .selectFrom("tracker_items")
        .select(["number", "synced_at"])
        .execute(),
    ).toEqual(before);
  });
});

describe("claiming a sync", () => {
  const claim = (cursor: string, startedAt: string) => ({
    cursor,
    startedAt,
    staleBefore: "2026-11-06T11:00:00.000Z",
  });

  // #923-R25
  it("lets one of two calls at the same time start the sync and leaves the state of the other alone", async () => {
    const { tracker, first } = await setup();

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        tracker.claimSync(
          first.id,
          claim(
            `{"phase":"issues","page":${index + 1}}`,
            `2026-11-06T12:00:0${index}.000Z`,
          ),
        ),
      ),
    );

    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    const winner = results.find((result) => result.claimed);
    for (const result of results)
      expect(result.state).toMatchObject({
        cursor: winner?.state?.cursor,
        startedAt: winner?.state?.startedAt,
      });
    expect(await tracker.getSyncState(first.id)).toMatchObject({
      cursor: winner?.state?.cursor,
      startedAt: winner?.state?.startedAt,
    });
  });

  // #923-R26
  it("takes a sync over when the last one ended, when it has not moved, or when its cursor is the unreadable one named", async () => {
    const { tracker, first } = await setup();
    const started = await tracker.claimSync(
      first.id,
      claim("A", "2026-11-06T12:00:00.000Z"),
    );
    expect(started.claimed).toBe(true);
    expect(started.state).toMatchObject({ cursor: "A", lastFullSyncAt: null });
    // Under way and moving (written after `staleBefore`): not free.
    expect(
      (
        await tracker.claimSync(
          first.id,
          claim("B", "2026-11-06T12:00:01.000Z"),
        )
      ).claimed,
    ).toBe(false);
    // Not moved since `staleBefore`: free.
    expect(
      (
        await tracker.claimSync(first.id, {
          cursor: "C",
          startedAt: "2026-11-07T12:00:00.000Z",
          staleBefore: "2030-01-01T00:00:00.000Z",
        })
      ).claimed,
    ).toBe(true);
    // The cursor named is the one the row holds: free; another text: not.
    expect(
      (
        await tracker.claimSync(first.id, {
          ...claim("D", "2026-11-07T12:00:00.000Z"),
          replacing: "other",
        })
      ).claimed,
    ).toBe(false);
    expect(
      (
        await tracker.claimSync(first.id, {
          ...claim("D", "2026-11-07T12:00:00.000Z"),
          replacing: "C",
        })
      ).claimed,
    ).toBe(true);
    // Ended: free, and the time of the last full sync is kept.
    await tracker.saveSyncState(first.id, {
      cursor: null,
      startedAt: null,
      lastFullSyncAt: "2026-11-07T13:00:00.000Z",
    });
    const again = await tracker.claimSync(
      first.id,
      claim("E", "2026-11-07T14:00:00.000Z"),
    );
    expect(again.claimed).toBe(true);
    expect(again.state).toMatchObject({
      cursor: "E",
      lastFullSyncAt: "2026-11-07T13:00:00.000Z",
    });
  });
});

describe("the project of the rows of the mirror (#922)", () => {
  // #922-T68
  it("writes the project of the repository with a ticket and with the state of a sync, and keeps it when the row is written again", async () => {
    const { tracker, first, second, db, workspaceId } = await setup();
    const projects = createProjectsRepository(db, workspaceId);
    const activated = await projects.activate(first.id);
    if (activated.kind !== "activated") throw new Error("seeding failed");
    const projectId = activated.project.id;

    await tracker.upsertItem(first.id, item(12));
    await tracker.upsertItem(second.id, item(12, { repo: "acme/repo-2" }));
    await tracker.saveSyncState(first.id, { cursor: "{}", startedAt: "x" });
    await tracker.claimSync(second.id, {
      cursor: "{}",
      startedAt: "2026-11-06T12:00:00.000Z",
      staleBefore: "2026-11-06T11:00:00.000Z",
    });

    expect((await tracker.getItem(first.id, 12))?.projectId).toBe(projectId);
    // A repository without a project has none.
    expect((await tracker.getItem(second.id, 12))?.projectId).toBeNull();
    const states = await db
      .selectFrom("tracker_sync_state")
      .select(["repository_id", "project_id"])
      .orderBy("repository_id")
      .execute();
    expect(
      Object.fromEntries(states.map((s) => [s.repository_id, s.project_id])),
    ).toEqual({ [first.id]: projectId, [second.id]: null });

    // The project of the second repository is made afterwards: the next write of a ticket takes it up.
    const later = await projects.activate(second.id);
    if (later.kind !== "activated") throw new Error("seeding failed");
    await tracker.upsertItem(
      second.id,
      item(12, {
        repo: "acme/repo-2",
        title: "Changed",
        updatedAt: "2026-11-06T11:00:00.000Z",
      }),
    );
    expect((await tracker.getItem(second.id, 12))?.projectId).toBe(
      later.project.id,
    );
  });
});
