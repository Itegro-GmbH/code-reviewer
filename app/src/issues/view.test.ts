// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { ticket, ticketList } from "./test-fixtures.ts";
import {
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

describe("what an issue waits for", () => {
  // #925-T01
  it("is a start for an open issue nothing is going on for and no pull request is linked to", () => {
    expect(waitsFor(REPO, ticket(1))).toEqual({ kind: "start" });
  });

  // #925-T02
  it("is an answer, with the run page's coordinates, while its lane waits for one", () => {
    const item = ticket(2, { lane: { ...running, status: "waiting" } });

    expect(waitsFor(REPO, item)).toEqual({
      kind: "answer",
      workflowId: "wf-1",
      runId: "run-1",
    });
  });

  // #925-T03
  it("is a review of the first linked pull request on GitHub when no lane works on the issue", () => {
    const item = ticket(3, { pullRequests: [9, 10] });

    expect(waitsFor(REPO, item)).toEqual({
      kind: "review",
      url: "https://github.com/acme/widgets/pull/9",
    });
  });

  // #925-T04
  it("is nothing while a lane runs, and nothing for a closed issue", () => {
    expect(waitsFor(REPO, ticket(4, { lane: running }))).toBeUndefined();
    expect(waitsFor(REPO, ticket(5, { state: "closed" }))).toBeUndefined();
  });

  // #925-T05
  it("makes no link from a repository name that is not owner/name", () => {
    expect(pullRequestUrl("not a repository", 1)).toBeUndefined();
    expect(waitsFor("not a repository", ticket(6, { pullRequests: [1] }))).toBe(
      undefined,
    );
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
    ]);

    expect(boardTiles(list)).toEqual({
      open: 4,
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
