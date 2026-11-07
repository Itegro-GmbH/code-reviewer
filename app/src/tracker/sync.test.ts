// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type {
  Integration,
  TrackerItemFields,
  TrackerPage,
  TrackerPageStep,
} from "../integrations/types.ts";
import { createFakeTrackerRepository } from "./fake-tracker-repository.ts";
import { createTrackerMirror } from "./mirror.ts";
import { createTrackerSync, readCursor, STALE_AFTER_MS } from "./sync.ts";

const INTEGRATION = { id: "i-1", workspaceId: "w-1" } as Integration;
const REPOSITORY = {
  id: "r-1",
  integrationId: "i-1",
  externalId: "7001",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
};

const item = (
  number: number,
  overrides: Partial<TrackerItemFields> = {},
): TrackerItemFields => ({
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
  parentNumber: null,
  closes: [],
  updatedAt: "2026-11-06T10:00:00.000Z",
  ...overrides,
});

/** What GitHub holds for the repository: the pages of the issues, the checks of the open pull requests and the boards. */
type GitHub = {
  issues: TrackerItemFields[][];
  checks: { number: number; checksState: string | null }[][];
  /** Pages of board items; null: the app may not read boards. */
  board: { nodeId: string; status: string | null }[][] | null;
};

const GITHUB: GitHub = {
  issues: [
    [
      item(3, { type: "Epic" }),
      item(12, {
        type: "Task",
        parentNumber: 3,
        labels: [{ name: "ready", color: "0e8a16" }],
      }),
    ],
    [
      item(13, { state: "closed", stateReason: "completed" }),
      item(7, {
        kind: "pull_request",
        nodeId: "PR_7",
        closes: [12],
        title: "Fix 12",
      }),
    ],
    [
      item(8, {
        kind: "pull_request",
        nodeId: "PR_8",
        closes: [13],
        state: "closed",
        stateReason: "merged",
      }),
    ],
  ],
  checks: [[{ number: 7, checksState: "failure" }]],
  board: [
    [{ nodeId: "N_12", status: "In Progress" }],
    [{ nodeId: "N_3", status: "Todo" }],
  ],
};

function provider(github: GitHub) {
  const steps: TrackerPageStep[] = [];
  const failures: (Error | undefined)[] = [];
  const readTrackerPage = vi.fn(
    async (
      _integration: Integration,
      _repo: unknown,
      step: TrackerPageStep,
    ): Promise<TrackerPage> => {
      steps.push(step);
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      if (step.phase === "issues")
        return {
          phase: "issues",
          items: github.issues[step.page - 1] ?? [],
          last: step.page >= github.issues.length,
        };
      if (step.phase === "checks")
        return {
          phase: "checks",
          pullRequests: github.checks[step.page - 1] ?? [],
          last: step.page >= github.checks.length,
        };
      if (github.board === null)
        return { phase: "board", available: false, items: [], next: null };
      const index = step.after === null ? 0 : Number(step.after);
      return {
        phase: "board",
        available: true,
        items: github.board[index] ?? [],
        next: index + 1 < github.board.length ? String(index + 1) : null,
      };
    },
  );
  return {
    steps,
    failures,
    readTrackerPage,
    port: { readTrackerPage } as Pick<IntegrationProvider, "readTrackerPage">,
  };
}

let clock = Date.parse("2026-11-06T12:00:00.000Z");
const tick = () => new Date((clock += 1000));

function setup(github: GitHub = GITHUB) {
  const tracker = createFakeTrackerRepository(tick);
  const remote = provider(github);
  const sync = createTrackerSync({ tracker, provider: remote.port, now: tick });
  return {
    tracker,
    remote,
    sync,
    run: (options = {}) => sync.run(INTEGRATION, REPOSITORY, options),
  };
}

describe("the full sync of the ticket mirror", () => {
  // #923-T32
  it("reads the issues, the checks and the board and ends with the cache complete", async () => {
    const { tracker, remote, run } = setup();

    const progress = await run();

    expect(progress).toEqual({
      status: "done",
      next: null,
      written: 5,
      removed: 0,
      boardAvailable: true,
    });
    expect(remote.steps).toEqual([
      { phase: "issues", page: 1 },
      { phase: "issues", page: 2 },
      { phase: "issues", page: 3 },
      { phase: "checks", page: 1 },
      { phase: "board", after: null },
      { phase: "board", after: "1" },
    ]);
    expect(tracker.rows().map((row) => row.number)).toEqual([3, 7, 8, 12, 13]);
    expect(await tracker.getItem("r-1", 12)).toMatchObject({
      type: "Task",
      parentNumber: 3,
      boardStatus: "In Progress",
      pullRequests: [7],
    });
    expect(await tracker.getItem("r-1", 13)).toMatchObject({
      pullRequests: [8],
    });
    expect(await tracker.getItem("r-1", 7)).toMatchObject({
      checksState: "failure",
    });
    expect(await tracker.getItem("r-1", 3)).toMatchObject({
      boardStatus: "Todo",
    });
    expect(await tracker.getSyncState("r-1")).toMatchObject({
      cursor: null,
      startedAt: null,
      lastFullSyncAt: expect.any(String),
    });
  });

  // #923-T33
  it("is resumable: a call that reads one page continues where the last one stopped", async () => {
    const { tracker, remote, run } = setup();

    const first = await run({ maxPages: 2 });
    expect(first).toMatchObject({
      status: "partial",
      next: "issues",
      written: 4,
    });
    expect(
      readCursor((await tracker.getSyncState("r-1"))?.cursor ?? null),
    ).toEqual({
      phase: "issues",
      page: 3,
    });

    const second = await run({ maxPages: 2 });
    expect(second).toMatchObject({
      status: "partial",
      next: "board",
      written: 1,
    });

    const third = await run({ maxPages: 5 });
    expect(third).toMatchObject({ status: "done", next: null });
    // Every page was read once: nothing was read again after it was saved.
    expect(remote.steps.map((step) => JSON.stringify(step))).toEqual([
      '{"phase":"issues","page":1}',
      '{"phase":"issues","page":2}',
      '{"phase":"issues","page":3}',
      '{"phase":"checks","page":1}',
      '{"phase":"board","after":null}',
      '{"phase":"board","after":"1"}',
    ]);
    expect(tracker.rows()).toHaveLength(5);
  });

  // #923-T34
  it("stops at the deadline and keeps the position", async () => {
    const { tracker, run } = setup();

    const progress = await run({ deadline: clock });

    expect(progress).toMatchObject({
      status: "partial",
      next: "issues",
      written: 0,
    });
    expect(tracker.rows()).toEqual([]);
    expect((await tracker.getSyncState("r-1"))?.cursor).not.toBeNull();
  });

  // #923-T35
  it("keeps the position of the last page that was written when GitHub fails, and continues with it", async () => {
    const { tracker, remote, run } = setup();
    remote.failures.push(undefined, new Error("boom"));

    await expect(run()).rejects.toThrow("boom");
    expect(tracker.rows().map((row) => row.number)).toEqual([3, 12]);
    expect(
      readCursor((await tracker.getSyncState("r-1"))?.cursor ?? null),
    ).toEqual({
      phase: "issues",
      page: 2,
    });

    const progress = await run();

    expect(progress.status).toBe("done");
    expect(tracker.rows()).toHaveLength(5);
  });

  // #923-T36
  it("removes what GitHub does not have any more, and nothing it still has", async () => {
    const { tracker, run } = setup();
    await run();
    await tracker.upsertItem("r-1", {
      provider: "github",
      repo: "acme/widgets",
      ...item(99, { title: "Deleted on GitHub while no delivery arrived" }),
    });
    expect(tracker.rows().map((row) => row.number)).toContain(99);

    const progress = await run();

    expect(progress).toMatchObject({ status: "done", removed: 1 });
    expect(tracker.rows().map((row) => row.number)).toEqual([3, 7, 8, 12, 13]);
  });

  // #923-T37
  it("forgets a board status and the checks that GitHub does not have any more", async () => {
    // The item left the board, and the checks of the pull request were re-run and are not known yet.
    const { tracker, run } = setup({
      ...GITHUB,
      board: [[]],
      checks: [[{ number: 7, checksState: null }]],
    });
    await tracker.upsertItem("r-1", {
      provider: "github",
      repo: "acme/widgets",
      ...item(12),
    });
    await tracker.upsertItem("r-1", {
      provider: "github",
      repo: "acme/widgets",
      ...item(7, { kind: "pull_request", nodeId: "PR_7" }),
    });
    await tracker.setBoardStatusByNode("N_12", "In Progress");
    await tracker.setChecksState("r-1", 7, "failure");

    await run();

    expect((await tracker.getItem("r-1", 12))?.boardStatus).toBeNull();
    expect((await tracker.getItem("r-1", 7))?.checksState).toBeNull();
  });

  // #923-T38
  it("goes on without a board when the app may not read boards", async () => {
    const { tracker, run } = setup({ ...GITHUB, board: null });

    const progress = await run();

    expect(progress).toMatchObject({ status: "done", boardAvailable: false });
    expect((await tracker.getItem("r-1", 12))?.boardStatus).toBeNull();
    expect(tracker.rows()).toHaveLength(5);
  });

  // #923-T39
  it("starts again from the beginning when the sync that was under way was abandoned", async () => {
    const { tracker, remote, run } = setup();
    await run({ maxPages: 1 });
    expect(remote.steps).toHaveLength(1);

    clock += STALE_AFTER_MS + 1;
    await run({ maxPages: 1 });

    expect(remote.steps.at(-1)).toEqual({ phase: "issues", page: 1 });
    expect(
      readCursor((await tracker.getSyncState("r-1"))?.cursor ?? null),
    ).toEqual({
      phase: "issues",
      page: 2,
    });
  });

  // #923-T40
  it("starts again when the saved position is not one", async () => {
    const { tracker, remote, run } = setup();
    await tracker.saveSyncState("r-1", {
      cursor: '{"phase":"nonsense"}',
      startedAt: new Date(clock).toISOString(),
    });

    await run({ maxPages: 1 });

    expect(remote.steps[0]).toEqual({ phase: "issues", page: 1 });
  });

  // #923-T41
  it("asks the provider for a phase it answers with another one as a failure", async () => {
    const tracker = createFakeTrackerRepository(tick);
    const sync = createTrackerSync({
      tracker,
      provider: {
        readTrackerPage: async () => ({
          phase: "board",
          available: true,
          items: [],
          next: null,
        }),
      },
      now: tick,
    });

    await expect(sync.run(INTEGRATION, REPOSITORY)).rejects.toThrow(
      /another phase/,
    );
  });
});

describe("the rebuild rule", () => {
  // #923-T42
  it("gives the same rows when the table is deleted and synced as when the webhooks kept it current", async () => {
    // The cache that the webhooks kept: every ticket as a delivery of its own, then the board and the checks.
    const kept = createFakeTrackerRepository(tick);
    const mirror = createTrackerMirror({
      repositories: {
        findByExternalId: async () => ({ id: "r-1", active: true }) as never,
      },
      projects: { hasActiveProject: async () => true },
      tracker: kept,
      checksStateOf: async () => "failure",
    });
    const repo = {
      integrationId: "i-1",
      externalId: "7001",
      fullName: "acme/widgets",
      url: "https://github.com/acme/widgets",
    };
    for (const page of GITHUB.issues)
      for (const ticket of page)
        await mirror.apply(INTEGRATION, {
          kind: "item_changed",
          repo,
          item: ticket,
          resetChecks: false,
        });
    for (const page of GITHUB.board ?? [])
      for (const { nodeId, status } of page)
        await mirror.apply(INTEGRATION, {
          kind: "board_status_changed",
          nodeId,
          status,
        });
    await mirror.apply(INTEGRATION, {
      kind: "checks_changed",
      repo,
      headSha: "abc1234",
      pullRequests: [7],
    });
    const before = kept.snapshot();
    expect(before).toHaveLength(5);

    // The table is deleted; the sync fills it again.
    const rebuilt = createFakeTrackerRepository(tick);
    const sync = createTrackerSync({
      tracker: rebuilt,
      provider: provider(GITHUB).port,
      now: tick,
    });
    await sync.run(INTEGRATION, REPOSITORY);

    expect(rebuilt.snapshot()).toEqual(before);

    // And once more over a cache that is already complete: the same again.
    await sync.run(INTEGRATION, REPOSITORY);
    expect(rebuilt.snapshot()).toEqual(before);
  });
});

describe("the position of a sync", () => {
  // #923-T43
  it.each([
    [null, undefined],
    ["not json", undefined],
    ['"text"', undefined],
    ['{"phase":"issues"}', undefined],
    ['{"phase":"issues","page":0}', undefined],
    ['{"phase":"checks","page":1.5}', undefined],
    ['{"phase":"board","after":5}', undefined],
    ['{"phase":"issues","page":4}', { phase: "issues", page: 4 }],
    ['{"phase":"checks","page":2}', { phase: "checks", page: 2 }],
    ['{"phase":"board","after":null}', { phase: "board", after: null }],
    ['{"phase":"board","after":"1:abc"}', { phase: "board", after: "1:abc" }],
  ])("reads %s as %j", (text, expected) => {
    expect(readCursor(text)).toEqual(expected);
  });
});
