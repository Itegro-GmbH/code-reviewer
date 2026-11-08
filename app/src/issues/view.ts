// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Issues tab takes from the list of tickets (#925): which of them are issues, what each waits for, the numbers of the tiles, the
// sub-issues and the pull request of an issue. Pure; the values are GitHub's, unmapped, and the addresses are checked before they become
// links (the list is data from outside).
import { githubLinkInRepository } from "../workflow-pages/github-link.ts";
import type { TicketList, TicketListItem } from "../tracker/service.ts";

/** What an issue waits for from the person looking at the board. */
export type WaitsFor =
  | { kind: "answer"; workflowId: string; runId: string }
  | { kind: "review"; url: string }
  | { kind: "start" };

export type BoardTiles = {
  open: number;
  working: number;
  waiting: number;
  spentUsd: number;
};

/** The issues of the list (a pull request is a ticket of the mirror too, but it is not a row of this table). */
export function issuesOf(list: TicketList): TicketListItem[] {
  return list.items.filter((item) => item.kind === "issue");
}

/** The address of a pull request of the repository, or undefined when it cannot be made into one safely. */
export function pullRequestUrl(
  repo: string,
  number: number,
): string | undefined {
  return githubLinkInRepository(
    `https://github.com/${repo}/pull/${number}`,
    repo,
  );
}

/** The address of the ticket on GitHub, or undefined when the list's address is not one of the repository's. */
export function ticketUrl(
  repo: string,
  item: TicketListItem,
): string | undefined {
  return githubLinkInRepository(item.url, repo);
}

/**
 * The state of a pull request linked to the issue, or undefined when it is not known: the cache's answer that came with the issue (it
 * covers pull requests outside of the loaded list), else the row of the list.
 */
export function pullRequestState(
  list: TicketList,
  item: TicketListItem,
  number: number,
): TicketListItem["state"] | undefined {
  return item.pullRequestStates[number] ?? pullRequestOf(list, number)?.state;
}

/**
 * The pull request of the issue that a person can review: the newest (highest number) of its linked pull requests that is open. A pull
 * request whose state is not known (the cache holds no row for it) does not count as open, so the issue keeps offering Start.
 */
export function openPullRequestOf(
  list: TicketList,
  item: TicketListItem,
): number | undefined {
  const open = item.pullRequests.filter(
    (number) => pullRequestState(list, item, number) === "open",
  );
  return open.length === 0 ? undefined : Math.max(...open);
}

/**
 * What the issue waits for: an answer when its lane asks one; a review when it is open, no lane works on it and a linked pull request is
 * open; a start when it is open and nothing is going on and no pull request is open. A closed issue, and one a lane is working on, waits
 * for nothing.
 */
export function waitsFor(
  list: TicketList,
  item: TicketListItem,
): WaitsFor | undefined {
  if (item.lane?.status === "waiting")
    return {
      kind: "answer",
      workflowId: item.lane.workflowId,
      runId: item.lane.runId,
    };
  if (item.lane !== null || item.state !== "open") return undefined;
  const pull = openPullRequestOf(list, item);
  if (pull === undefined) return { kind: "start" };
  const url = pullRequestUrl(list.repo, pull);
  return url === undefined ? undefined : { kind: "review", url };
}

/** Nothing changes quickly any more: no lane is running (a lane that waits for an answer changes when somebody answers). */
export function boardSettled(list: TicketList): boolean {
  return issuesOf(list).every((item) => item.lane?.status !== "running");
}

export function boardTiles(list: TicketList): BoardTiles {
  const issues = issuesOf(list);
  return {
    open: issues.filter((item) => item.state === "open").length,
    working: issues.filter((item) => item.lane !== null).length,
    waiting: issues.filter((item) => {
      const kind = waitsFor(list, item)?.kind;
      return kind === "answer" || kind === "review";
    }).length,
    spentUsd: issues.reduce((sum, item) => sum + item.costUsd, 0),
  };
}

/** The issues that have this one as their parent. */
export function subIssuesOf(
  list: TicketList,
  number: number,
): TicketListItem[] {
  return issuesOf(list).filter((item) => item.parentNumber === number);
}

/** The pull request of the list with this number, when the list holds it. */
export function pullRequestOf(
  list: TicketList,
  number: number,
): TicketListItem | undefined {
  return list.items.find(
    (item) => item.kind === "pull_request" && item.number === number,
  );
}

/** Dollars as the board writes them: cents, and sub-cent amounts as "< $0.01". */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "< $0.01";
  return `$${usd.toFixed(2)}`;
}

/** How long a run has been going, "2 h 5 min"; "–" for a time that cannot be read. */
export function formatSince(startedAt: string, now: Date): string {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "–";
  const minutes = Math.max(0, Math.floor((now.getTime() - start) / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)} h ${String(minutes % 60)} min`;
}
