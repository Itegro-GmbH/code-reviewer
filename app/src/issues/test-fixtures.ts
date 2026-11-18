// SPDX-License-Identifier: LicenseRef-Proprietary

// Tickets as the issues route gives them, for the tests of the Issues tab (#925).
import type {
  TicketLane,
  TicketList,
  TicketListItem,
} from "../tracker/service.ts";
import type { StartLane } from "./start-lanes.ts";

export function ticket(
  number: number,
  overrides: Partial<TicketListItem> = {},
): TicketListItem {
  return {
    key: String(number),
    number,
    kind: "issue",
    state: "open",
    stateReason: null,
    type: null,
    title: `Ticket ${String(number)}`,
    bodyExcerpt: "",
    labels: [],
    assignees: [],
    boardStatus: null,
    parentNumber: null,
    pullRequests: [],
    pullRequestStates: {},
    checksState: null,
    updatedAt: "2026-11-06T10:00:00.000Z",
    syncedAt: "2026-11-06T10:05:00.000Z",
    url: `https://github.com/acme/widgets/issues/${String(number)}`,
    lane: null,
    costUsd: 0,
    ...overrides,
  };
}

export function ticketList(
  items: TicketListItem[],
  overrides: Partial<TicketList> = {},
): TicketList {
  return {
    provider: "github",
    repositoryId: "repo-1",
    repo: "acme/widgets",
    items,
    sync: {
      lastFullSyncAt: "2026-11-06T09:00:00.000Z",
      inProgress: false,
      lastWriteAt: null,
    },
    ...overrides,
  };
}

export const LANE: StartLane = {
  workflowId: "wf-1",
  name: "Issue to PR",
  description: "Implement the ticket, have it reviewed, open the pull request.",
  trigger: "manual",
  ticketField: "ticket",
  firstSteps: ["Action: ticket.labels", "Repeat: up to 3 rounds"],
  budgetUsd: 20,
  turnTimeLimitMinutes: 60,
};

/** A lane run on a ticket with its track (#1080): three steps, the first done, the second running. */
export const TRACKED_LANE: TicketLane = {
  runId: "run-9",
  workflowId: "wf-9",
  name: "Issue to PR",
  step: "review",
  status: "running",
  nodes: [
    {
      id: "implement",
      kind: "agent",
      note: "Implement",
      connector: null,
      innerIds: [],
      body: [],
    },
    {
      id: "review",
      kind: "agent",
      note: "Review",
      connector: null,
      innerIds: [],
      body: [],
    },
    {
      id: "merge",
      kind: "action",
      note: null,
      connector: "pr.merge",
      innerIds: [],
      body: [],
    },
  ],
  steps: [
    { id: "implement", kind: "agent", status: "succeeded", round: 1 },
    { id: "review", kind: "agent", status: "running", round: 1 },
  ],
};
