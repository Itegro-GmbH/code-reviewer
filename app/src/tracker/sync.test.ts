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
import {
  createTrackerSync,
  readCursor,
  RESUME_STALE_AFTER_MS,
  STALE_AFTER_MS,
} from "./sync.ts";

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

/** The nth second of the day the fixtures happen on: what orders the list GitHub answers. */
const at = (second: number) =>
  new Date(Date.UTC(2026, 10, 6, 10, 0, second)).toISOString();

/** What GitHub holds for the repository: the issues (answered the least recently changed first), the checks of the open pull requests and the boards. */
type GitHub = {
  issues: TrackerItemFields[];
  /** How many items one page of the list holds. */
  pageSize: number;
  checks: {
    number: number;
    checksState: string | null;
    reviewRequestedFrom?: string[];
    /** The time of the pull request in the list; default: later than every delivery of the fixtures. */
    updatedAt?: string;
  }[][];
  /** Pages of board items; null: the app may not read boards. */
  board: { nodeId: string; status: string | null }[][] | null;
  /** How many tickets of each page cannot be read (`skipped` of the page). */
  skippedPerPage?: number;
};

const GITHUB: GitHub = {
  pageSize: 3,
  issues: [
    item(3, { type: "Epic", updatedAt: at(1) }),
    item(12, {
      type: "Task",
      parentNumber: 3,
      labels: [{ name: "ready", color: "0e8a16" }],
      updatedAt: at(2),
    }),
    item(13, { state: "closed", stateReason: "completed", updatedAt: at(3) }),
    item(7, {
      kind: "pull_request",
      nodeId: "PR_7",
      closes: [12],
      title: "Fix 12",
      updatedAt: at(4),
    }),
    item(8, {
      kind: "pull_request",
      nodeId: "PR_8",
      closes: [13],
      state: "closed",
      stateReason: "merged",
      updatedAt: at(5),
    }),
  ],
  checks: [
    [{ number: 7, checksState: "failure", reviewRequestedFrom: ["ada"] }],
  ],
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
      if (step.phase === "issues") {
        // As GitHub answers: from `since` on, in pages of `pageSize`.
        const listed = github.issues.filter(
          (listedItem) =>
            step.since === undefined || listedItem.updatedAt >= step.since,
        );
        const items = listed.slice(
          (step.page - 1) * github.pageSize,
          step.page * github.pageSize,
        );
        return {
          phase: "issues",
          items,
          last: items.length < github.pageSize,
          ...(github.skippedPerPage === undefined
            ? {}
            : { skipped: github.skippedPerPage }),
        };
      }
      if (step.phase === "checks")
        return {
          phase: "checks",
          pullRequests: (github.checks[step.page - 1] ?? []).map(
            (pullRequest) => ({
              ...pullRequest,
              reviewRequestedFrom: pullRequest.reviewRequestedFrom ?? [],
              updatedAt: pullRequest.updatedAt ?? at(59),
            }),
          ),
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
  const warn = vi.fn<(line: string) => void>();
  const sync = createTrackerSync({
    tracker,
    provider: remote.port,
    now: tick,
    warn,
  });
  return {
    tracker,
    remote,
    sync,
    warn,
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
      written: 7,
      removed: 0,
      skipped: 0,
      boardAvailable: true,
    });
    // The list is walked by the time of the last change: each walk continues from the last item of the one before (read once more).
    expect(remote.steps).toEqual([
      { phase: "issues", page: 1 },
      { phase: "issues", page: 1, since: at(3) },
      { phase: "issues", page: 1, since: at(5) },
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
    // #924-T05: the checks phase reads who a review of the open pull request is asked from
    expect(await tracker.getItem("r-1", 7)).toMatchObject({
      checksState: "failure",
      reviewRequestedFrom: ["ada"],
    });
    expect(await tracker.getItem("r-1", 8)).toMatchObject({
      reviewRequestedFrom: [],
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

  // #924-T08
  it("does not overwrite who a review is asked from with a list that is older than what a delivery said", async () => {
    // the list the sync reads was taken before that delivery: it shows the request of ada, which carol's delivery replaced
    const { tracker, run } = setup({
      ...GITHUB,
      checks: [
        [
          {
            number: 7,
            checksState: "failure",
            reviewRequestedFrom: ["ada"],
            updatedAt: at(10),
          },
        ],
      ],
    });
    await tracker.upsertItem("r-1", {
      provider: "github",
      repo: "acme/widgets",
      ...item(7, {
        kind: "pull_request",
        title: "Pull request",
        reviewRequestedFrom: ["carol"],
        updatedAt: at(30),
      }),
    });

    await run();

    expect((await tracker.getItem("r-1", 7))?.reviewRequestedFrom).toEqual([
      "carol",
    ]);
  });

  // #923-T33
  it("is resumable: a call that reads one page continues where the last one stopped", async () => {
    const { tracker, remote, run } = setup();

    const first = await run({ maxPages: 2 });
    expect(first).toMatchObject({
      status: "partial",
      next: "issues",
      written: 6,
    });
    expect(
      readCursor((await tracker.getSyncState("r-1"))?.cursor ?? null),
    ).toEqual({
      phase: "issues",
      page: 1,
      since: at(5),
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
      `{"phase":"issues","page":1,"since":"${at(3)}"}`,
      `{"phase":"issues","page":1,"since":"${at(5)}"}`,
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
    expect(tracker.rows().map((row) => row.number)).toEqual([3, 12, 13]);
    expect(
      readCursor((await tracker.getSyncState("r-1"))?.cursor ?? null),
    ).toEqual({
      phase: "issues",
      page: 1,
      since: at(3),
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
      page: 1,
      since: at(3),
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
        get: async () => undefined,
      },
      projects: { hasActiveProject: async () => true },
      tracker: kept,
      boardStatusOf: async () => ({ available: false, status: null }),
      checksStateOf: async () => "failure",
    });
    const repo = {
      integrationId: "i-1",
      externalId: "7001",
      fullName: "acme/widgets",
      url: "https://github.com/acme/widgets",
    };
    for (const ticket of GITHUB.issues)
      await mirror.apply(INTEGRATION, {
        kind: "item_changed",
        repo,
        // The object of a pull request in a webhook carries who a review is asked from; the list of the issues does not (the checks do).
        item:
          ticket.kind === "pull_request"
            ? {
                ...ticket,
                reviewRequestedFrom:
                  GITHUB.checks
                    .flat()
                    .find((pull) => pull.number === ticket.number)
                    ?.reviewRequestedFrom ?? [],
              }
            : ticket,
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
    [
      '{"phase":"issues","page":1,"since":"2026-11-06T10:00:03.000Z","skipped":2}',
      {
        phase: "issues",
        page: 1,
        since: "2026-11-06T10:00:03.000Z",
        skipped: 2,
      },
    ],
    ['{"phase":"issues","page":1,"since":"yesterday"}', undefined],
    ['{"phase":"issues","page":1,"since":5}', undefined],
    ['{"phase":"checks","page":2,"skipped":0}', { phase: "checks", page: 2 }],
    ['{"phase":"checks","page":2}', { phase: "checks", page: 2 }],
    ['{"phase":"board","after":null}', { phase: "board", after: null }],
    ['{"phase":"board","after":"1:abc"}', { phase: "board", after: "1:abc" }],
  ])("reads %s as %j", (text, expected) => {
    expect(readCursor(text)).toEqual(expected);
  });
});

describe("a sync that is bigger or slower than one call", () => {
  // #923-R06
  it("walks a list of more than 100 pages to its end by the time of the last change", async () => {
    const issues = Array.from({ length: 10_550 }, (_, index) =>
      item(index + 1, { updatedAt: at(index + 1) }),
    );
    const { tracker, remote, run } = setup({
      issues,
      pageSize: 100,
      checks: [],
      board: null,
    });

    const progress = await run({ maxPages: 1000 });

    expect(progress).toMatchObject({ status: "done", removed: 0, skipped: 0 });
    expect(tracker.rows()).toHaveLength(10_550);
    const reads = remote.steps.filter((step) => step.phase === "issues");
    // More than the 100 pages the client lets one walk have, and none of them asks for a page beyond it.
    expect(reads.length).toBeGreaterThan(100);
    expect(
      Math.max(
        ...reads.map((step) => (step.phase === "issues" ? step.page : 0)),
      ),
    ).toBe(1);
  });

  // #923-R07
  it("goes on by page within a time that more than a page of items share", async () => {
    const issues = Array.from({ length: 250 }, (_, index) =>
      item(index + 1, { updatedAt: at(7) }),
    );
    const { tracker, remote, run } = setup({
      issues,
      pageSize: 100,
      checks: [],
      board: null,
    });

    await run();

    expect(tracker.rows()).toHaveLength(250);
    expect(remote.steps.filter((step) => step.phase === "issues")).toEqual([
      { phase: "issues", page: 1 },
      { phase: "issues", page: 1, since: at(7) },
      { phase: "issues", page: 2, since: at(7) },
      { phase: "issues", page: 3, since: at(7) },
    ]);
  });

  // #923-R08
  it("does not reset the sync another call has under way, and continues it", async () => {
    const { tracker, remote, run } = setup();
    await run({ maxPages: 1 });
    const under = await tracker.getSyncState("r-1");
    expect(under?.startedAt).not.toBeNull();

    // A second call while the first one is between its pages: it takes the position that is saved and does not start over.
    await run({ maxPages: 1 });

    expect(remote.steps.map((step) => JSON.stringify(step))).toEqual([
      '{"phase":"issues","page":1}',
      `{"phase":"issues","page":1,"since":"${at(3)}"}`,
    ]);
    expect((await tracker.getSyncState("r-1"))?.startedAt).toBe(
      under?.startedAt,
    );
  });

  // #923-R09
  it("keeps a sync alive for as long as it moves: staleness is counted from the last page, not from the start", async () => {
    const { remote, run } = setup();
    await run({ maxPages: 1 });
    clock += STALE_AFTER_MS - 60_000;
    await run({ maxPages: 1 });
    clock += STALE_AFTER_MS - 60_000;

    // The sync began more than an hour ago, but its last page was written less than an hour ago.
    await run({ maxPages: 1 });

    expect(remote.steps.map((step) => JSON.stringify(step))).toEqual([
      '{"phase":"issues","page":1}',
      `{"phase":"issues","page":1,"since":"${at(3)}"}`,
      `{"phase":"issues","page":1,"since":"${at(5)}"}`,
    ]);
  });
});

describe("what a sync leaves alone when it cannot know", () => {
  // #923-R10
  it("removes nothing, says so and reports the count when a ticket of the list could not be read", async () => {
    const { tracker, run, warn } = setup({ ...GITHUB, skippedPerPage: 1 });
    await run();
    await tracker.upsertItem("r-1", {
      provider: "github",
      repo: "acme/widgets",
      ...item(99, { title: "Looks gone, but one ticket could not be read" }),
    });

    const progress = await run();

    // One per page, three pages.
    expect(progress).toMatchObject({ status: "done", removed: 0, skipped: 3 });
    expect(tracker.rows().map((row) => row.number)).toEqual([
      3, 7, 8, 12, 13, 99,
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("3 ticket(s)"));
    expect(warn.mock.calls.flat().join("\n")).not.toContain("Looks gone");
  });

  // #923-R11
  it("adds the tickets that could not be read over the calls of one sync", async () => {
    const { run } = setup({ ...GITHUB, skippedPerPage: 1 });

    await run({ maxPages: 1 });
    const second = await run({ maxPages: 1 });
    expect(second).toMatchObject({ status: "partial", skipped: 2 });
    expect(await run()).toMatchObject({ status: "done", skipped: 3 });
  });

  // #923-R12
  it("keeps the board statuses when the board cannot be read, and goes on from there", async () => {
    const { tracker, remote, run } = setup({
      ...GITHUB,
      board: [[{ nodeId: "N_3", status: "Todo" }]],
    });
    await run();
    expect((await tracker.getItem("r-1", 12))?.boardStatus).toBeNull();
    await tracker.setBoardStatusByNode("N_12", "In Progress");
    // Issues (3 reads) and checks (1) are read, then the board fails.
    remote.failures.push(
      undefined,
      undefined,
      undefined,
      undefined,
      new Error("GraphQL had an error"),
    );

    await expect(run()).rejects.toThrow("GraphQL");

    expect((await tracker.getItem("r-1", 12))?.boardStatus).toBe("In Progress");
    expect(await run()).toMatchObject({ status: "done" });
    expect(await tracker.getItem("r-1", 12)).toMatchObject({
      boardStatus: null,
    });
    expect(await tracker.getItem("r-1", 3)).toMatchObject({
      boardStatus: "Todo",
    });
  });

  // #923-R13
  it("keeps a status that a delivery set while the board phase was still to come", async () => {
    const { tracker, run } = setup({
      ...GITHUB,
      board: [[{ nodeId: "N_3", status: "Todo" }]],
    });
    await run();
    await tracker.setBoardStatusByNode("N_12", "In Progress");
    // The sync reads the issues and the checks, and stops before the board.
    await run({ maxPages: 4 });
    // A webhook says the item moved while the sync is between its phases.
    await tracker.setBoardStatusByNode("N_12", "In Review");

    await run();

    expect((await tracker.getItem("r-1", 12))?.boardStatus).toBe("In Review");
    expect((await tracker.getItem("r-1", 3))?.boardStatus).toBe("Todo");
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("a sync the nightly run continues (#932)", () => {
  // #932-R30
  it("continues an unfinished sync a day later when asked to resume, and keeps the time the sync began", async () => {
    const { tracker, remote, run } = setup();
    await run({ maxPages: 1 });
    const under = await tracker.getSyncState("r-1");

    clock += DAY_MS;
    await run({ maxPages: 1, resume: true });

    expect(remote.steps.map((step) => JSON.stringify(step))).toEqual([
      '{"phase":"issues","page":1}',
      `{"phase":"issues","page":1,"since":"${at(3)}"}`,
    ]);
    expect((await tracker.getSyncState("r-1"))?.startedAt).toBe(
      under?.startedAt,
    );
  });

  // #932-R31
  it("starts again after a day when not asked to resume: the sync of a request is abandoned after an hour", async () => {
    const { remote, run } = setup();
    await run({ maxPages: 1 });

    clock += DAY_MS;
    await run({ maxPages: 1 });

    expect(remote.steps.at(-1)).toEqual({ phase: "issues", page: 1 });
  });

  // #932-R32
  it("starts again when the sync did not move for longer than a resume waits", async () => {
    const { remote, run } = setup();
    await run({ maxPages: 1 });

    clock += RESUME_STALE_AFTER_MS + 1;
    await run({ maxPages: 1, resume: true });

    expect(remote.steps.at(-1)).toEqual({ phase: "issues", page: 1 });
  });

  // #932-R33
  it("completes over several nights and then applies the rebuild rule from the time the sync began, not from the last night", async () => {
    const { tracker, remote, run } = setup();
    await tracker.upsertItem("r-1", {
      provider: "github",
      repo: "acme/widgets",
      ...item(99, { title: "Deleted on GitHub while no delivery arrived" }),
    });

    // One page a night: the issues of the first nights are written before the sync ends.
    let progress = await run({ maxPages: 1, resume: true });
    let nights = 1;
    while (progress.status === "partial") {
      clock += DAY_MS;
      progress = await run({ maxPages: 1, resume: true });
      nights += 1;
      expect(nights).toBeLessThan(20);
    }

    expect(nights).toBeGreaterThan(3);
    // Item 3 was written on the first night, the others later: only the one GitHub does not have is removed.
    expect(progress).toMatchObject({ status: "done", removed: 1 });
    expect(tracker.rows().map((row) => row.number)).toEqual([3, 7, 8, 12, 13]);
    expect(remote.steps.filter((step) => step.phase === "issues")[0]).toEqual({
      phase: "issues",
      page: 1,
    });
  });
});

describe("the checks of a sync that is cut in the middle (#932)", () => {
  const PULL_REQUESTS: GitHub = {
    pageSize: 5,
    issues: [
      item(7, { kind: "pull_request", nodeId: "PR_7", updatedAt: at(1) }),
      item(8, { kind: "pull_request", nodeId: "PR_8", updatedAt: at(2) }),
      item(9, {
        kind: "pull_request",
        nodeId: "PR_9",
        state: "closed",
        stateReason: "merged",
        updatedAt: at(3),
      }),
    ],
    checks: [
      [{ number: 7, checksState: "failure" }],
      [{ number: 8, checksState: "success" }],
    ],
    board: [[]],
  };

  async function seeded() {
    const context = setup(PULL_REQUESTS);
    for (const number of [7, 8, 9]) {
      await context.tracker.upsertItem("r-1", {
        provider: "github",
        repo: "acme/widgets",
        ...item(number, {
          kind: "pull_request",
          nodeId: `PR_${number}`,
          updatedAt: at(0),
        }),
      });
      await context.tracker.setChecksState("r-1", number, "pending");
    }
    return context;
  }

  // #932-R34
  it("leaves the checks of the pull requests it has not reached unchanged", async () => {
    const { tracker, run } = await seeded();

    // The issues page, then the first page of the checks: the second page is still to come.
    const progress = await run({ maxPages: 2 });

    expect(progress).toMatchObject({ status: "partial", next: "checks" });
    expect((await tracker.getItem("r-1", 7))?.checksState).toBe("failure");
    expect((await tracker.getItem("r-1", 8))?.checksState).toBe("pending");
    expect((await tracker.getItem("r-1", 9))?.checksState).toBe("pending");
  });

  // #932-R35
  it("reads the rest on the next call and forgets the checks of what is not an open pull request at the end of the checks", async () => {
    const { tracker, run } = await seeded();
    await run({ maxPages: 2 });

    const progress = await run();

    expect(progress).toMatchObject({ status: "done" });
    expect((await tracker.getItem("r-1", 8))?.checksState).toBe("success");
    // Closed: GitHub does not list it among the pull requests with checks.
    expect((await tracker.getItem("r-1", 9))?.checksState).toBeNull();
  });
});
