// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { ticket, ticketList } from "./test-fixtures.ts";
import {
  boardSettled,
  boardTiles,
  formatSince,
  formatUsd,
  issuesOf,
  pullRequestOf,
  pullRequestUrl,
  subIssuesOf,
  ticketUrl,
  waitsFor,
} from "./view.ts";

const REPO = "acme/widgets";
const running = {
  runId: "run-1",
  workflowId: "wf-1",
  name: "Issue to PR",
  step: "implement",
  status: "running" as const,
};

type Pulls = Record<number, "open" | "closed" | "merged">;

function listWith(issue: ReturnType<typeof ticket>, pulls: Pulls = {}) {
  return ticketList([
    issue,
    ...Object.entries(pulls).map(([number, state]) =>
      ticket(Number(number), {
        kind: "pull_request",
        state: state === "open" ? "open" : "closed",
        stateReason: state === "merged" ? "merged" : null,
      }),
    ),
  ]);
}

const waits = (issue: ReturnType<typeof ticket>, pulls: Pulls = {}) =>
  waitsFor(listWith(issue, pulls), issue);

describe("what an issue waits for", () => {
  // #925-T01
  it("is a start for an open issue nothing is going on for and no pull request is linked to", () => {
    expect(waits(ticket(1))).toEqual({ kind: "start" });
  });

  // #925-T02
  it("is an answer, with the run page's coordinates, while its lane waits for one", () => {
    const item = ticket(2, { lane: { ...running, status: "waiting" } });

    expect(waits(item)).toEqual({
      kind: "answer",
      workflowId: "wf-1",
      runId: "run-1",
    });
  });

  // #925-T03
  it("is a review of the linked pull request on GitHub when it is open and no lane works on the issue", () => {
    const item = ticket(3, { pullRequests: [9] });

    expect(waits(item, { 9: "open" })).toEqual({
      kind: "review",
      url: "https://github.com/acme/widgets/pull/9",
    });
  });

  // #925-T04
  it("is nothing while a lane runs, and nothing for a closed issue", () => {
    expect(waits(ticket(4, { lane: running }))).toBeUndefined();
    expect(waits(ticket(5, { state: "closed" }))).toBeUndefined();
  });

  // #925-T05
  it("makes no link from a repository name that is not owner/name", () => {
    expect(pullRequestUrl("not a repository", 1)).toBeUndefined();
    const item = ticket(6, { pullRequests: [1] });
    expect(
      waitsFor(
        ticketList([item, ticket(1, { kind: "pull_request" })], {
          repo: "not a repository",
        }),
        item,
      ),
    ).toBe(undefined);
  });

  // #925-T40
  it("is a start, not a review, when the linked pull request was closed without merging or was merged", () => {
    const item = ticket(7, { pullRequests: [11, 12] });

    expect(waits(item, { 11: "closed", 12: "merged" })).toEqual({
      kind: "start",
    });
  });

  // #925-T41
  it("reviews the newest open pull request when an old one was closed and a newer one is open", () => {
    const item = ticket(8, { pullRequests: [20, 25, 22] });

    expect(waits(item, { 20: "open", 22: "closed", 25: "open" })).toEqual({
      kind: "review",
      url: "https://github.com/acme/widgets/pull/25",
    });
    expect(waits(item, { 20: "closed", 22: "closed", 25: "closed" })).toEqual({
      kind: "start",
    });
  });

  // #925-T42
  it("does not count a linked pull request the list does not hold as open: its state is unknown", () => {
    const item = ticket(9, { pullRequests: [30] });

    expect(waits(item)).toEqual({ kind: "start" });
  });
});

describe("the list", () => {
  // #925-T06
  it("has the issues as rows and the pull requests as data for the drawer", () => {
    const list = ticketList([
      ticket(1),
      ticket(2, { kind: "pull_request", checksState: "success" }),
      ticket(3, { parentNumber: 1 }),
    ]);

    expect(issuesOf(list).map((item) => item.number)).toEqual([1, 3]);
    expect(subIssuesOf(list, 1).map((item) => item.number)).toEqual([3]);
    expect(pullRequestOf(list, 2)?.checksState).toBe("success");
    expect(pullRequestOf(list, 1)).toBeUndefined();
  });

  // #925-T07
  it("counts open issues, lanes, what waits for the person and what was spent", () => {
    const list = ticketList([
      ticket(1),
      ticket(2, { lane: running, costUsd: 1.5 }),
      ticket(3, { lane: { ...running, status: "waiting" }, costUsd: 0.25 }),
      ticket(4, { pullRequests: [8] }),
      ticket(5, { state: "closed", costUsd: 2 }),
      ticket(6, { kind: "pull_request", costUsd: 100 }),
      ticket(8, { kind: "pull_request" }),
      // A closed pull request is nothing to review: this issue waits for a start, not for the person.
      ticket(9, { pullRequests: [10] }),
      ticket(10, { kind: "pull_request", state: "closed" }),
    ]);

    expect(boardTiles(list)).toEqual({
      open: 5,
      working: 2,
      waiting: 2,
      spentUsd: 3.75,
    });
  });

  // #925-T08
  it("links an issue only to its own repository on github.com", () => {
    expect(ticketUrl(REPO, ticket(1))).toBe(
      "https://github.com/acme/widgets/issues/1",
    );
    expect(
      ticketUrl(REPO, ticket(1, { url: "https://evil.example/acme/widgets" })),
    ).toBeUndefined();
  });
});

describe("when the board stops asking quickly", () => {
  // #925-T48
  it("asks quickly only while a lane runs: a lane that waits for an answer is settled until somebody answers", () => {
    const waiting = { ...running, status: "waiting" as const };

    expect(boardSettled(ticketList([ticket(1)]))).toBe(true);
    expect(boardSettled(ticketList([ticket(1, { lane: waiting })]))).toBe(true);
    expect(
      boardSettled(
        ticketList([
          ticket(1, { lane: waiting }),
          ticket(2, { lane: running }),
        ]),
      ),
    ).toBe(false);
  });
});

describe("the figures", () => {
  // #925-T09
  it("writes dollars in cents and says '< $0.01' for less", () => {
    expect([0, 0.004, 1.2345, 20].map(formatUsd)).toEqual([
      "$0.00",
      "< $0.01",
      "$1.23",
      "$20.00",
    ]);
  });

  // #925-T10
  it("says how long a run has been going", () => {
    const now = new Date("2026-11-07T12:00:00.000Z");

    expect(formatSince("2026-11-07T11:59:50.000Z", now)).toBe("under a minute");
    expect(formatSince("2026-11-07T11:30:00.000Z", now)).toBe("30 min");
    expect(formatSince("2026-11-07T09:55:00.000Z", now)).toBe("2 h 5 min");
    expect(formatSince("nonsense", now)).toBe("–");
  });
});
