// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The lane runs list of the Runs page (#1078): what a row shows, the text alternative of the step track, links, text only for what
// people typed, polling while a run is active, and further pages.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../ui/json-request.ts";
import type {
  LaneRunListItemView,
  LaneRunListView,
} from "../workflow-runs/lane-run-list.ts";
import { WORKFLOW_RUN_POLL_MS, type WorkflowRunsApi } from "./api.ts";
import { LaneRunsList } from "./lane-runs-list.tsx";
import { LANE_RUNS_COPY } from "./messages.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = "2026-11-18T12:00:00.000Z";

function item(
  overrides: Partial<LaneRunListItemView> = {},
): LaneRunListItemView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowVersion: 3,
    laneName: "Ship it",
    status: "running",
    errorCode: null,
    project: { id: "repo-1", name: "acme/widgets" },
    ticket: {
      label: "#128",
      title: "Cache the thing",
      url: "https://github.com/acme/widgets/issues/128",
    },
    nodes: [
      {
        id: "plan",
        kind: "agent",
        note: "Plan",
        connector: null,
        innerIds: [],
      },
      {
        id: "review",
        kind: "agent",
        note: "Review",
        connector: null,
        innerIds: [],
      },
      {
        id: "ship",
        kind: "action",
        note: null,
        connector: "pr.merge",
        innerIds: [],
      },
    ],
    steps: [
      { id: "plan", kind: "agent", status: "succeeded", round: 1 },
      { id: "review", kind: "agent", status: "running", round: 1 },
    ],
    budgetUsd: 20,
    spentUsd: 1.25,
    createdAt: "2026-11-18T11:48:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

const page = (
  runs: LaneRunListItemView[],
  nextCursor: string | null = null,
): LaneRunListView => ({ runs, nextCursor, now: NOW });
const ok = (view: LaneRunListView): RequestResult<LaneRunListView> => ({
  ok: true,
  data: view,
});

function renderList(
  initial: LaneRunListView,
  answers: RequestResult<LaneRunListView>[] = [],
  filter = {},
) {
  const api = {
    listWorkspace: vi.fn(
      async () =>
        answers.shift() ??
        ({
          ok: false,
          status: 500,
          code: "UNEXPECTED_RESPONSE",
          issues: [],
        } as const),
    ),
  } as unknown as WorkflowRunsApi & { listWorkspace: ReturnType<typeof vi.fn> };
  const view = render(
    <LaneRunsList
      workspaceSlug="acme"
      filter={filter}
      initial={initial}
      api={api}
    />,
  );
  return { ...view, api };
}

describe("a row of the lane runs list", () => {
  // #1078-T60
  it("shows the ticket, lane with version, project, status, start, duration and spent of the budget", () => {
    const { container } = renderList(page([item()]));

    const row = within(container.querySelector("tbody tr") as HTMLElement);
    expect(row.getByText("#128")).toBeTruthy();
    expect(row.getByText("Cache the thing")).toBeTruthy();
    expect(row.getByText("Ship it")).toBeTruthy();
    expect(row.getByText("version 3")).toBeTruthy();
    expect(row.getByText("acme/widgets")).toBeTruthy();
    expect(row.getByText("Running")).toBeTruthy();
    expect(row.getByText("12 min ago")).toBeTruthy();
    expect(row.getByText("12 min 00 s")).toBeTruthy();
    expect(row.getByText("$1.25 of $20.00")).toBeTruthy();
  });

  // #1078-T61
  it("links the ticket to its page and the lane to the run page of the workspace", () => {
    renderList(page([item()]));

    expect(
      screen
        .getByRole("link", { name: /Open the ticket #128/ })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/issues/128");
    expect(
      screen
        .getByRole("link", { name: new RegExp(LANE_RUNS_COPY.openRun) })
        .getAttribute("href"),
    ).toBe("/w/acme/workflows/wf-1/runs/run-1");
  });

  // #1078-T62
  it("gives the step track a text alternative with the position and the state of the current step", () => {
    renderList(page([item()]));

    expect(
      screen.getByRole("img", { name: "Step 2 of 3: Review, running" }),
    ).toBeTruthy();
  });

  // #1078-T63
  it("draws one segment for each node of the lane, by state", () => {
    const { container } = renderList(page([item()]));

    const states = [...container.querySelectorAll("[data-state]")].map(
      (segment) => segment.getAttribute("data-state"),
    );
    expect(states).toEqual(["done", "running", "not_reached"]);
    expect(
      container
        .querySelector("[data-current=true]")
        ?.getAttribute("data-state"),
    ).toBe("running");
  });

  // #1078-T64
  it("shows what people typed as text, never as markup", () => {
    const hostile = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    const { container } = renderList(
      page([
        item({
          laneName: hostile,
          project: { id: "repo-1", name: hostile },
          ticket: { label: "#1", title: hostile, url: null },
          nodes: [
            {
              id: "a",
              kind: "agent",
              note: hostile,
              connector: null,
              innerIds: [],
            },
          ],
          steps: [{ id: "a", kind: "agent", status: "running", round: 1 }],
        }),
      ]),
    );

    expect(container.querySelector("img, script")).toBeNull();
    expect(container.textContent).toContain(hostile);
  });

  // #1078-T65
  it("says when there is no ticket, no title, or no project, and shows a ticket without a link as text", () => {
    const { container } = renderList(
      page([
        item({ id: "a", ticket: null }),
        item({
          id: "b",
          ticket: { label: "LAT-58", title: null, url: null },
          project: { id: "r", name: null },
        }),
      ]),
    );

    const rows = container.querySelectorAll("tbody tr");
    expect(rows[0]?.textContent).toContain(LANE_RUNS_COPY.noTicket);
    expect(rows[1]?.textContent).toContain("LAT-58");
    expect(rows[1]?.textContent).toContain(LANE_RUNS_COPY.ticketUntitled);
    expect(rows[1]?.textContent).toContain(LANE_RUNS_COPY.projectGone);
    expect(
      within(rows[1] as HTMLElement).queryByRole("link", {
        name: /Open the ticket/,
      }),
    ).toBeNull();
  });

  // #1078-T66
  it("keeps the order it is given, greys a discarded run and tells a failure in words", () => {
    const { container } = renderList(
      page([
        item({ id: "run-3", status: "running" }),
        item({
          id: "run-2",
          status: "failed",
          errorCode: "budget_exhausted",
          finishedAt: "2026-11-18T11:55:00.000Z",
        }),
        item({
          id: "run-1",
          status: "discarded",
          finishedAt: "2026-11-18T11:55:00.000Z",
        }),
      ]),
    );

    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows.map((row) => row.getAttribute("data-run-id"))).toEqual([
      "run-3",
      "run-2",
      "run-1",
    ]);
    expect(rows[2]?.className).toContain("opacity-60");
    expect(rows[1]?.textContent).toContain("budget of the run is used up");
    expect(container.textContent).not.toContain("budget_exhausted");
  });

  // #1078-T67
  it("says there is nothing to see, and says so differently when a filter is set", () => {
    renderList(page([]));
    expect(screen.getByText(LANE_RUNS_COPY.emptyDescription)).toBeTruthy();
    cleanup();

    renderList(page([]), [], { status: "failed" });
    expect(screen.getByText(LANE_RUNS_COPY.emptyFiltered)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("while a run is active", () => {
  // #1078-T68
  it("asks again with the filter, shows the newer list and stops when no run is active", async () => {
    const { api, container } = renderList(
      page([item()]),
      [
        ok(
          page([
            item({
              status: "succeeded",
              finishedAt: "2026-11-18T11:59:00.000Z",
            }),
          ]),
        ),
      ],
      { status: "active", project: "repo-1" },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS);
    });
    expect(container.querySelector("tbody")?.textContent).toContain(
      "Succeeded",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS * 5);
    });

    expect(api.listWorkspace).toHaveBeenCalledTimes(1);
    expect(api.listWorkspace).toHaveBeenCalledWith({
      status: "active",
      project: "repo-1",
    });
  });

  // #1078-T69
  it("polls a run that waits for an answer, and none once every run has ended", async () => {
    const waiting = renderList(page([item({ status: "waiting" })]), [
      ok(page([item({ status: "waiting" })])),
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS);
    });
    expect(waiting.api.listWorkspace).toHaveBeenCalled();
    cleanup();

    const ended = renderList(
      page([
        item({ status: "failed", finishedAt: "2026-11-18T11:59:00.000Z" }),
      ]),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS * 5);
    });
    expect(ended.api.listWorkspace).not.toHaveBeenCalled();
  });
});

describe("more runs", () => {
  // #1078-T70
  it("loads the next page with the cursor and appends it, and offers no more after the last", async () => {
    const { api, container } = renderList(
      page(
        [
          item({
            id: "run-2",
            status: "succeeded",
            finishedAt: "2026-11-18T11:59:00.000Z",
          }),
        ],
        "cursor-1",
      ),
      [
        ok(
          page([
            item({
              id: "run-1",
              status: "succeeded",
              finishedAt: "2026-11-18T11:59:00.000Z",
            }),
          ]),
        ),
      ],
      { lane: "wf-1" },
    );

    fireEvent.click(
      screen.getByRole("button", { name: LANE_RUNS_COPY.loadMore }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(api.listWorkspace).toHaveBeenCalledWith({
      lane: "wf-1",
      cursor: "cursor-1",
    });
    expect(
      [...container.querySelectorAll("tbody tr")].map((row) =>
        row.getAttribute("data-run-id"),
      ),
    ).toEqual(["run-2", "run-1"]);
    expect(
      screen.queryByRole("button", { name: LANE_RUNS_COPY.loadMore }),
    ).toBeNull();
  });

  // #1078-T71
  it("says so when the next page could not be loaded, and keeps the runs it has", async () => {
    renderList(
      page(
        [item({ status: "succeeded", finishedAt: "2026-11-18T11:59:00.000Z" })],
        "cursor-1",
      ),
    );

    fireEvent.click(
      screen.getByRole("button", { name: LANE_RUNS_COPY.loadMore }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText(LANE_RUNS_COPY.loadMoreFailed)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: LANE_RUNS_COPY.loadMore }),
    ).toBeTruthy();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
  });
});
