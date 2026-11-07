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

function setup(options: { project?: boolean; active?: boolean } = {}) {
  const tracker = createFakeTrackerRepository();
  const checksStateOf = vi.fn(async () => "failure" as string | null);
  const mirror = createTrackerMirror({
    repositories: {
      async findByExternalId(integrationId, externalId) {
        return integrationId === "i-1" && externalId === "7001"
          ? ({ id: "r-1", active: options.active ?? true } as never)
          : undefined;
      },
    },
    projects: { hasActiveProject: async () => options.project ?? true },
    tracker,
    checksStateOf,
  });
  const changed = (item: TrackerItemFields, resetChecks = false) =>
    mirror.apply(INTEGRATION, {
      kind: "item_changed",
      repo: REPO,
      item,
      resetChecks,
    });
  return { tracker, mirror, checksStateOf, changed };
}

describe("applying a change of a ticket to the mirror", () => {
  // #923-T21
  it("writes a ticket and replaces it when it changes, keeping what other deliveries said", async () => {
    const { tracker, changed } = setup();

    expect(
      await changed(issue(12, { labels: [{ name: "a", color: "1" }] })),
    ).toBe("updated");
    await tracker.setBoardStatusByNode("I_12", "In Progress");
    await tracker.setParent("r-1", 12, 3);
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

    const removal = { kind: "item_removed", repo: REPO, number: 12 } as const;
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
    });
    expect((await tracker.getItem("r-1", 12))?.parentNumber).toBe(3);
    await mirror.apply(INTEGRATION, {
      kind: "parent_changed",
      repo: REPO,
      child: 12,
      parent: null,
    });
    expect((await tracker.getItem("r-1", 12))?.parentNumber).toBeNull();
    expect(
      await mirror.apply(INTEGRATION, {
        kind: "parent_changed",
        repo: REPO,
        child: 99,
        parent: 3,
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
