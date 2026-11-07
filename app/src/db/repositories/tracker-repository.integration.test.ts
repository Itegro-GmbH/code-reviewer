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
    expect(await tracker.setParent(first.id, 12, 5)).toBe(true);
    expect((await tracker.getItem(first.id, 12))?.parentNumber).toBe(5);
    expect(await tracker.setParent(first.id, 99, 5)).toBe(false);
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
  it("finds the item of a board by the node id of its content, and forgets the statuses of one repository", async () => {
    const { tracker, first, second } = await setup();
    await tracker.upsertItem(first.id, item(12));
    await tracker.upsertItem(
      second.id,
      item(12, { repo: "acme/repo-2", nodeId: "N_other" }),
    );
    await tracker.setBoardStatusByNode("N_other", "Done");

    expect(await tracker.setBoardStatusByNode("N_12", "In Progress")).toBe(1);
    expect(await tracker.setBoardStatusByNode("N_unknown", "Done")).toBe(0);
    await tracker.clearBoardStatuses(first.id);

    expect((await tracker.getItem(first.id, 12))?.boardStatus).toBeNull();
    expect((await tracker.getItem(second.id, 12))?.boardStatus).toBe("Done");
  });

  // #923-T94
  it("sets and forgets the checks of a pull request", async () => {
    const { tracker, first } = await setup();
    await tracker.upsertItem(first.id, item(7, { kind: "pull_request" }));

    expect(await tracker.setChecksState(first.id, 7, "failure")).toBe(true);
    expect((await tracker.getItem(first.id, 7))?.checksState).toBe("failure");
    await tracker.clearChecksStates(first.id);
    expect((await tracker.getItem(first.id, 7))?.checksState).toBeNull();
    expect(await tracker.setChecksState(first.id, 99, "failure")).toBe(false);
  });

  // #923-T95
  it("removes a ticket, and the tickets not written since a time", async () => {
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
    expect(await tracker.deleteItem(first.id, 2)).toBe(true);
    expect(await tracker.deleteItem(first.id, 2)).toBe(false);
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
