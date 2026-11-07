// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type { Integration, TrackerItemFields } from "../integrations/types.ts";
import { createFakeTrackerRepository } from "./fake-tracker-repository.ts";
import { createTrackerMirror, TRACKER_PROVIDER } from "./mirror.ts";

const INTEGRATION = { id: "i-1", workspaceId: "w-1" } as Integration;
const REPO = {
  integrationId: "i-1",
  externalId: "7001",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
};

const issue = (
  number: number,
  overrides: Partial<TrackerItemFields> = {},
): TrackerItemFields => ({
  number,
  nodeId: `I_${number}`,
  kind: "issue",
  state: "open",
  stateReason: null,
  type: null,
  title: `Issue ${number}`,
  bodyExcerpt: "",
  labels: [],
  assignees: [],
  closes: [],
  updatedAt: "2026-11-06T10:00:00.000Z",
  ...overrides,
});

const pullRequest = (
  number: number,
  closes: number[],
  overrides: Partial<TrackerItemFields> = {},
) =>
  issue(number, {
    nodeId: `PR_${number}`,
    kind: "pull_request",
    closes,
    ...overrides,
  });

type BoardRead = { available: boolean; status: string | null };

function setup(
  options: { project?: boolean; active?: boolean; board?: BoardRead } = {},
) {
  const tracker = createFakeTrackerRepository();
  const checksStateOf = vi.fn(async () => "failure" as string | null);
  const boardStatusOf = vi.fn(
    async (): Promise<BoardRead> =>
      options.board ?? { available: true, status: null },
  );
  const mirror = createTrackerMirror({
    repositories: {
      async findByExternalId(integrationId, externalId) {
        return integrationId === "i-1" && externalId === "7001"
          ? ({ id: "r-1", active: options.active ?? true } as never)
          : undefined;
      },
      async get(id) {
        return id === "r-1"
          ? ({
              id: "r-1",
              integrationId: "i-1",
              externalId: "7001",
              fullName: "acme/widgets",
              url: "https://github.com/acme/widgets",
              active: options.active ?? true,
            } as never)
          : undefined;
      },
    },
    projects: { hasActiveProject: async () => options.project ?? true },
    tracker,
    boardStatusOf,
    checksStateOf,
  });
  const changed = (item: TrackerItemFields, resetChecks = false) =>
    mirror.apply(INTEGRATION, {
      kind: "item_changed",
      repo: REPO,
      item,
      resetChecks,
    });
  return { tracker, mirror, checksStateOf, boardStatusOf, changed };
}

describe("applying a change of a ticket to the mirror", () => {
  // #923-T21
  it("writes a ticket and replaces it when it changes, keeping what other deliveries said", async () => {
    const { tracker, changed } = setup();

    expect(
      await changed(issue(12, { labels: [{ name: "a", color: "1" }] })),
    ).toBe("updated");
    await tracker.setBoardStatusByNode("I_12", "In Progress");
    await tracker.setParent("r-1", 12, 3, "2026-11-06T10:00:00.000Z");
    await changed(
      issue(12, {
        title: "Renamed",
        state: "closed",
        stateReason: "completed",
      }),
    );

    expect(await tracker.getItem("r-1", 12)).toMatchObject({
      provider: TRACKER_PROVIDER,
      repo: "acme/widgets",
      title: "Renamed",
      state: "closed",
      stateReason: "completed",
      labels: [],
      boardStatus: "In Progress",
    });
  });

  // #923-T22
  it("keeps the parent of an issue when the delivery does not say, and sets or empties it when it does", async () => {
    const { tracker, changed } = setup();
    await changed(issue(12, { parentNumber: 3 }));
    await changed(issue(12));
    expect((await tracker.getItem("r-1", 12))?.parentNumber).toBe(3);

    await changed(issue(12, { parentNumber: null }));

    expect((await tracker.getItem("r-1", 12))?.parentNumber).toBeNull();
  });

  // #923-T23
  it("lists a pull request on the issues it closes, and takes it off those it does not close any more", async () => {
    const { tracker, changed } = setup();
    await changed(issue(12));
    await changed(issue(13));

    await changed(pullRequest(7, [12, 13]));
    expect((await tracker.getItem("r-1", 12))?.pullRequests).toEqual([7]);
    expect((await tracker.getItem("r-1", 13))?.pullRequests).toEqual([7]);

    await changed(pullRequest(7, [13]));
    expect((await tracker.getItem("r-1", 12))?.pullRequests).toEqual([]);
    expect((await tracker.getItem("r-1", 13))?.pullRequests).toEqual([7]);
  });

  // #923-T24
  it("clears the checks of a new commit and of a pull request that is over", async () => {
    const { tracker, changed } = setup();
    await changed(pullRequest(7, []));
    await tracker.setChecksState("r-1", 7, "success");

    await changed(pullRequest(7, [], { title: "Edited" }));
    expect((await tracker.getItem("r-1", 7))?.checksState).toBe("success");

    await changed(pullRequest(7, []), true);
    expect((await tracker.getItem("r-1", 7))?.checksState).toBeNull();

    await tracker.setChecksState("r-1", 7, "failure");
    await changed(
      pullRequest(7, [], { state: "closed", stateReason: "merged" }),
    );
    expect((await tracker.getItem("r-1", 7))?.checksState).toBeNull();
  });

  // #923-T25
  it("removes a deleted issue, and says so when it was not cached", async () => {
    const { tracker, mirror, changed } = setup();
    await changed(issue(12));

    const removal = {
      kind: "item_removed",
      repo: REPO,
      number: 12,
      at: "2026-11-06T10:00:00.000Z",
    } as const;
    expect(await mirror.apply(INTEGRATION, removal)).toBe("updated");
    expect(await tracker.getItem("r-1", 12)).toBeUndefined();
    expect(await mirror.apply(INTEGRATION, removal)).toBe("not_mirrored");
  });

  // #923-T26
  it("sets and empties the parent of a cached sub-issue", async () => {
    const { tracker, mirror, changed } = setup();
    await changed(issue(12));

    await mirror.apply(INTEGRATION, {
      kind: "parent_changed",
      repo: REPO,
      child: 12,
      parent: 3,
      at: "2026-11-06T10:00:01.000Z",
    });
    expect((await tracker.getItem("r-1", 12))?.parentNumber).toBe(3);
    await mirror.apply(INTEGRATION, {
      kind: "parent_changed",
      repo: REPO,
      child: 12,
      parent: null,
      at: "2026-11-06T10:00:02.000Z",
    });
    expect((await tracker.getItem("r-1", 12))?.parentNumber).toBeNull();
    expect(
      await mirror.apply(INTEGRATION, {
        kind: "parent_changed",
        repo: REPO,
        child: 99,
        parent: 3,
        at: "2026-11-06T10:00:03.000Z",
      }),
    ).toBe("not_mirrored");
  });

  // #923-T27
  it("sets the board status of the ticket the board names by its node id", async () => {
    const { tracker, mirror, changed } = setup();
    await changed(issue(12));

    expect(
      await mirror.apply(INTEGRATION, {
        kind: "board_status_changed",
        nodeId: "I_12",
        status: "Done",
      }),
    ).toBe("updated");
    expect((await tracker.getItem("r-1", 12))?.boardStatus).toBe("Done");
    expect(
      await mirror.apply(INTEGRATION, {
        kind: "board_status_changed",
        nodeId: "I_12",
        status: null,
      }),
    ).toBe("updated");
    expect((await tracker.getItem("r-1", 12))?.boardStatus).toBeNull();
    expect(
      await mirror.apply(INTEGRATION, {
        kind: "board_status_changed",
        nodeId: "I_nobody",
        status: "Done",
      }),
    ).toBe("not_mirrored");
  });

  // #932-T01
  it.each([
    ["created", false],
    ["restored", false],
    ["archived", true],
    ["deleted", true],
  ])(
    "asks the boards where the ticket stands when an item is %s, and stores what they say",
    async (_action, removed) => {
      const { tracker, mirror, boardStatusOf, changed } = setup({
        board: { available: true, status: "In Review" },
      });
      await changed(issue(12));
      await tracker.setBoardStatusByNode("I_12", "Todo");

      expect(
        await mirror.apply(INTEGRATION, {
          kind: "board_item_reread",
          nodeId: "I_12",
          removed,
        }),
      ).toBe("updated");

      // One question, about the repository the ticket is cached in.
      expect(boardStatusOf).toHaveBeenCalledExactlyOnceWith(
        INTEGRATION,
        REPO,
        "I_12",
      );
      expect((await tracker.getItem("r-1", 12))?.boardStatus).toBe("In Review");
    },
  );

  // #932-T02
  it("empties the status of an item that left its only board, and keeps the status another board gives", async () => {
    const none = setup({ board: { available: true, status: null } });
    await none.changed(issue(12));
    await none.tracker.setBoardStatusByNode("I_12", "Todo");
    await none.mirror.apply(INTEGRATION, {
      kind: "board_item_reread",
      nodeId: "I_12",
      removed: true,
    });
    expect((await none.tracker.getItem("r-1", 12))?.boardStatus).toBeNull();

    // Deleted from one board while it is on another: that board still names a status, and the ticket keeps it.
    const other = setup({ board: { available: true, status: "Done" } });
    await other.changed(issue(12));
    await other.tracker.setBoardStatusByNode("I_12", "Todo");
    await other.mirror.apply(INTEGRATION, {
      kind: "board_item_reread",
      nodeId: "I_12",
      removed: true,
    });
    expect((await other.tracker.getItem("r-1", 12))?.boardStatus).toBe("Done");
  });

  // #932-T03
  it("empties the status of an item that left the board when the boards cannot be read, and leaves a created or restored one alone", async () => {
    const { tracker, mirror, changed } = setup({
      board: { available: false, status: null },
    });
    await changed(issue(12));
    await tracker.setBoardStatusByNode("I_12", "Todo");

    expect(
      await mirror.apply(INTEGRATION, {
        kind: "board_item_reread",
        nodeId: "I_12",
        removed: false,
      }),
    ).toBe("not_mirrored");
    expect((await tracker.getItem("r-1", 12))?.boardStatus).toBe("Todo");

    expect(
      await mirror.apply(INTEGRATION, {
        kind: "board_item_reread",
        nodeId: "I_12",
        removed: true,
      }),
    ).toBe("updated");
    expect((await tracker.getItem("r-1", 12))?.boardStatus).toBeNull();
  });

  // #932-T04
  it("asks nothing for a ticket it does not hold or a repository without an active project", async () => {
    const held = setup();
    expect(
      await held.mirror.apply(INTEGRATION, {
        kind: "board_item_reread",
        nodeId: "I_nobody",
        removed: false,
      }),
    ).toBe("not_mirrored");

    const off = setup({ project: false });
    await off.changed(issue(12));
    expect(
      await off.mirror.apply(INTEGRATION, {
        kind: "board_item_reread",
        nodeId: "I_12",
        removed: false,
      }),
    ).toBe("not_mirrored");

    expect(held.boardStatusOf).not.toHaveBeenCalled();
    expect(off.boardStatusOf).not.toHaveBeenCalled();
  });

  // #932-T05
  it("fails the delivery when GitHub cannot be asked, so that it is redelivered", async () => {
    const { tracker, mirror, boardStatusOf, changed } = setup();
    boardStatusOf.mockRejectedValueOnce(new Error("GitHub is down"));
    await changed(issue(12));
    await tracker.setBoardStatusByNode("I_12", "Todo");

    await expect(
      mirror.apply(INTEGRATION, {
        kind: "board_item_reread",
        nodeId: "I_12",
        removed: true,
      }),
    ).rejects.toThrow("GitHub is down");
    expect((await tracker.getItem("r-1", 12))?.boardStatus).toBe("Todo");
  });

  // #923-T28
  it("asks GitHub for the checks once and stores them on the open pull requests that have the commit", async () => {
    const { tracker, mirror, checksStateOf, changed } = setup();
    await changed(pullRequest(7, []));
    await changed(pullRequest(8, []));
    await changed(pullRequest(9, [], { state: "closed" }));
    await changed(issue(10));

    const outcome = await mirror.apply(INTEGRATION, {
      kind: "checks_changed",
      repo: REPO,
      headSha: "abc1234",
      pullRequests: [7, 8, 9, 10, 99],
    });

    expect(outcome).toBe("updated");
    expect(checksStateOf).toHaveBeenCalledTimes(1);
    expect(checksStateOf).toHaveBeenCalledWith(INTEGRATION, REPO, "abc1234");
    expect((await tracker.getItem("r-1", 7))?.checksState).toBe("failure");
    expect((await tracker.getItem("r-1", 8))?.checksState).toBe("failure");
    expect((await tracker.getItem("r-1", 9))?.checksState).toBeNull();
    expect((await tracker.getItem("r-1", 10))?.checksState).toBeNull();
  });

  // #923-T29
  it("does not ask GitHub for the checks of a commit no cached pull request has", async () => {
    const { mirror, checksStateOf } = setup();

    expect(
      await mirror.apply(INTEGRATION, {
        kind: "checks_changed",
        repo: REPO,
        headSha: "abc1234",
        pullRequests: [7],
      }),
    ).toBe("not_mirrored");
    expect(checksStateOf).not.toHaveBeenCalled();
  });

  // #923-T30
  it.each([
    ["a repository without an active project", { project: false }],
    [
      "a repository that the platform does not list any more",
      { active: false },
    ],
  ])("mirrors nothing of %s", async (_name, options) => {
    const { tracker, changed } = setup(options);

    expect(await changed(issue(12))).toBe("not_mirrored");
    expect(tracker.rows()).toEqual([]);
  });

  // #923-T31
  it("mirrors nothing of a repository of another installation", async () => {
    const { tracker, mirror } = setup();

    expect(
      await mirror.apply(INTEGRATION, {
        kind: "item_changed",
        repo: { ...REPO, externalId: "7999" },
        item: issue(12),
        resetChecks: false,
      }),
    ).toBe("not_mirrored");
    expect(tracker.rows()).toEqual([]);
  });
});

describe("deliveries that arrive out of order or twice", () => {
  const T1 = "2026-11-06T10:00:01.000Z";
  const T2 = "2026-11-06T10:00:02.000Z";
  const T3 = "2026-11-06T10:00:03.000Z";

  // #923-R01
  it("drops an issue delivery older than the one the cache holds, and a replay of the same one", async () => {
    const { tracker, changed } = setup();
    await changed(issue(12, { title: "New", updatedAt: T2 }));

    expect(await changed(issue(12, { title: "Old", updatedAt: T1 }))).toBe(
      "not_mirrored",
    );
    expect(await changed(issue(12, { title: "New", updatedAt: T2 }))).toBe(
      "updated",
    );

    expect(await tracker.getItem("r-1", 12)).toMatchObject({
      title: "New",
      updatedAt: T2,
    });
  });

  // #923-R02
  it("drops a pull request delivery older than the cache: its checks, its reference to the issues and its state stay", async () => {
    const { tracker, changed } = setup();
    await changed(issue(12));
    await changed(
      pullRequest(7, [12], {
        title: "Newer",
        state: "closed",
        stateReason: "merged",
        updatedAt: T2,
      }),
    );
    await tracker.setChecksState("r-1", 7, "success");

    // The `synchronize` of an older commit arrives late: it would clear the checks and open the pull request again.
    expect(
      await changed(
        pullRequest(7, [], { title: "Older", state: "open", updatedAt: T1 }),
        true,
      ),
    ).toBe("not_mirrored");

    expect(await tracker.getItem("r-1", 7)).toMatchObject({
      title: "Newer",
      state: "closed",
      closes: [12],
      checksState: "success",
    });
    expect((await tracker.getItem("r-1", 12))?.pullRequests).toEqual([7]);
  });

  // #923-R03
  it("drops a parent change older than the cache, in either order of the two changes", async () => {
    const { tracker, mirror, changed } = setup();
    await changed(issue(12, { updatedAt: T1 }));
    const parent = (to: number | null, at: string) =>
      mirror.apply(INTEGRATION, {
        kind: "parent_changed",
        repo: REPO,
        child: 12,
        parent: to,
        at,
      });

    // Removed at T3, but the delivery of "added at T2" comes after it.
    expect(await parent(null, T3)).toBe("updated");
    expect(await parent(3, T2)).toBe("not_mirrored");
    expect((await tracker.getItem("r-1", 12))?.parentNumber).toBeNull();

    // And an issue delivery older than the parent change does not undo it either.
    expect(await parent(5, "2026-11-06T10:00:04.000Z")).toBe("updated");
    expect(await changed(issue(12, { parentNumber: 3, updatedAt: T3 }))).toBe(
      "not_mirrored",
    );
    expect((await tracker.getItem("r-1", 12))?.parentNumber).toBe(5);
  });

  // #923-R04
  it("keeps a deleted issue gone when an older delivery comes after the deletion, and takes a newer one", async () => {
    const { tracker, mirror, changed } = setup();
    await changed(issue(12, { updatedAt: T1 }));
    await mirror.apply(INTEGRATION, {
      kind: "item_removed",
      repo: REPO,
      number: 12,
      at: T2,
    });

    // An edit from before the deletion, and one at the very time of it: neither brings the issue back.
    expect(await changed(issue(12, { title: "Late", updatedAt: T1 }))).toBe(
      "not_mirrored",
    );
    expect(await changed(issue(12, { title: "Same", updatedAt: T2 }))).toBe(
      "not_mirrored",
    );
    expect(await tracker.getItem("r-1", 12)).toBeUndefined();
    expect(tracker.tombstones()).toEqual([12]);

    // A delivery after the deletion is news (the issue exists again): it is written.
    expect(await changed(issue(12, { title: "Back", updatedAt: T3 }))).toBe(
      "updated",
    );
    expect(await tracker.getItem("r-1", 12)).toMatchObject({ title: "Back" });
    expect(tracker.tombstones()).toEqual([]);
  });

  // #923-R05
  it("drops a deletion older than the cache (the issue changed after it)", async () => {
    const { tracker, mirror, changed } = setup();
    await changed(issue(12, { updatedAt: T2 }));

    expect(
      await mirror.apply(INTEGRATION, {
        kind: "item_removed",
        repo: REPO,
        number: 12,
        at: T1,
      }),
    ).toBe("not_mirrored");
    expect(await tracker.getItem("r-1", 12)).toBeDefined();
  });
});
