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
  LaneNodesByKey,
  LaneNodeView,
} from "../workflow-runs/lane-nodes.ts";
import type {
  LaneRunListItemView,
  LaneRunListView,
} from "../workflow-runs/lane-run-list.ts";
import {
  LANE_RUNS_WAITING_POLL_MS,
  WORKFLOW_RUN_POLL_MS,
  type WorkflowRunsApi,
} from "./api.ts";
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

const NODES_KEY = "wf-1@3|ticket.labeled|label";
const NODES: LaneNodeView[] = [
  {
    id: "plan",
    kind: "agent",
    note: "Plan",
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
    id: "ship",
    kind: "action",
    note: null,
    connector: "pr.merge",
    innerIds: [],
    body: [],
  },
];

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
    trigger: "ticket.labeled",
    actorLogin: "ada",
    project: { id: "repo-1", name: "acme/widgets" },
    ticket: {
      label: "#128",
      title: "Cache the thing",
      key: "128",
      githubRepository: "acme/widgets",
      jiraSiteUrl: null,
    },
    nodesKey: NODES_KEY,
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
  laneNodes: LaneNodesByKey = { [NODES_KEY]: NODES },
): LaneRunListView => ({ runs, laneNodes, nextCursor, now: NOW });
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

  // #1078-T75
  it("makes the ticket link through the repository of the ticket only: a reference that walks out of it is shown as text", () => {
    for (const repository of ["../..", "./..", "a/b/../../c"])
      renderList(
        page([
          item({
            ticket: {
              label: "#1",
              title: "Hostile",
              key: "1",
              githubRepository: repository,
              jiraSiteUrl: null,
            },
          }),
        ]),
      );

    expect(screen.queryAllByRole("link", { name: /Open the ticket/ })).toEqual(
      [],
    );
    expect(screen.getAllByText("#1")).toHaveLength(3);
  });

  // #1086-T05
  it("links a Jira ticket to its issue on the site of the project's connection, and shows it as text without a usable site", () => {
    const jira = (jiraSiteUrl: string | null) =>
      item({
        id: jiraSiteUrl ?? "none",
        ticket: {
          label: "LAT-58",
          title: "Jira title",
          key: "LAT-58",
          githubRepository: null,
          jiraSiteUrl,
        },
      });
    renderList(
      page([
        jira("https://acme.atlassian.net"),
        jira(null),
        jira("http://acme.atlassian.net"),
      ]),
    );

    const links = screen.getAllByRole("link", { name: /Open the ticket/ });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://acme.atlassian.net/browse/LAT-58",
    ]);
    expect(screen.getAllByText("LAT-58")).toHaveLength(3);
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
      page(
        [
          item({
            laneName: hostile,
            project: { id: "repo-1", name: hostile },
            ticket: {
              label: "#1",
              title: hostile,
              key: "1",
              githubRepository: null,
              jiraSiteUrl: null,
            },
            steps: [{ id: "a", kind: "agent", status: "running", round: 1 }],
          }),
        ],
        null,
        {
          [NODES_KEY]: [
            {
              id: "a",
              kind: "agent",
              note: hostile,
              connector: null,
              innerIds: [],
              body: [],
            },
          ],
        },
      ),
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
          ticket: {
            label: "LAT-58",
            title: null,
            key: "LAT-58",
            githubRepository: null,
            jiraSiteUrl: null,
          },
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
      await vi.advanceTimersByTimeAsync(LANE_RUNS_WAITING_POLL_MS);
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

describe("how often the list asks", () => {
  // #1078-T72
  it("asks slowly while every active run only waits for an answer, and at the pace of a running run otherwise", async () => {
    const waiting = renderList(page([item({ status: "waiting" })]), [
      ok(page([item({ status: "waiting" })])),
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS * 5);
    });
    expect(waiting.api.listWorkspace).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        LANE_RUNS_WAITING_POLL_MS - WORKFLOW_RUN_POLL_MS * 5,
      );
    });
    expect(waiting.api.listWorkspace).toHaveBeenCalledTimes(1);
    cleanup();

    const mixed = renderList(
      page([
        item({ id: "run-1", status: "waiting" }),
        item({ id: "run-2", status: "running" }),
      ]),
      [ok(page([item({ id: "run-1", status: "waiting" })]))],
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS);
    });
    expect(mixed.api.listWorkspace).toHaveBeenCalledTimes(1);
  });

  // #1078-T73
  it("speeds up again when a waiting run starts to run", async () => {
    const { api } = renderList(page([item({ status: "waiting" })]), [
      ok(page([item({ status: "running" })])),
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LANE_RUNS_WAITING_POLL_MS);
    });
    expect(api.listWorkspace).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS);
    });
    expect(api.listWorkspace).toHaveBeenCalledTimes(2);
  });
});

describe("more runs", () => {
  // #1078-T74
  it("shows a run once when pages that were read at different times overlap", async () => {
    const ended = (id: string) =>
      item({
        id,
        status: "succeeded",
        finishedAt: "2026-11-18T11:59:00.000Z",
      });
    const { container } = renderList(
      page([ended("run-a"), ended("run-b")], "cursor-1"),
      [
        // a run that ended between two reads is on the page after the cursor and was on the first one
        ok(page([ended("run-b"), ended("run-c")], "cursor-2")),
        ok(page([ended("run-c"), ended("run-d")])),
      ],
    );

    for (let pages = 0; pages < 2; pages += 1) {
      fireEvent.click(
        screen.getByRole("button", { name: LANE_RUNS_COPY.loadMore }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    expect(
      [...container.querySelectorAll("tbody tr")].map((row) =>
        row.getAttribute("data-run-id"),
      ),
    ).toEqual(["run-a", "run-b", "run-c", "run-d"]);
  });

  // #1087-T08
  it("draws a run of a later page on the nodes that page brings, and keeps the nodes of the earlier pages", async () => {
    const OTHER_KEY = "wf-2@1|manual|by-hand";
    const other = (id: string) =>
      item({ id, workflowId: "wf-2", nodesKey: OTHER_KEY });
    const { container } = renderList(
      page([item({ id: "run-a" })], "cursor-1"),
      [
        ok(
          page([other("run-b")], null, {
            [OTHER_KEY]: [NODES[0] as LaneNodeView],
          }),
        ),
      ],
    );

    fireEvent.click(
      screen.getByRole("button", { name: LANE_RUNS_COPY.loadMore }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const segments = (id: string) =>
      container.querySelectorAll(`tr[data-run-id="${id}"] [data-state]`).length;
    expect(segments("run-a")).toBe(3);
    expect(segments("run-b")).toBe(1);
  });

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

describe("the Runs section of a lane's page (#1080)", () => {
  function renderInLane(initial: LaneRunListView, canStart = true) {
    const listWorkspace = vi.fn(async () => ok(initial));
    const api = { listWorkspace } as unknown as WorkflowRunsApi;
    render(
      <LaneRunsList
        workspaceSlug="acme"
        filter={{ lane: "wf-1" }}
        inLane={{ canStart }}
        initial={initial}
        api={api}
      />,
    );
    return { listWorkspace };
  }

  // #1080-T30
  it("lists the runs of the lane with the same track and a link to each run", () => {
    renderInLane(page([item(), item({ id: "run-2", status: "succeeded" })]));

    const rows = screen
      .getAllByRole("row")
      .filter((row) => row.hasAttribute("data-run-id"));
    expect(rows.map((row) => row.getAttribute("data-run-id"))).toEqual([
      "run-1",
      "run-2",
    ]);
    const first = within(rows[0] as HTMLElement);
    expect(
      first.getByRole("img", { name: "Step 2 of 3: Review, running" }),
    ).toBeTruthy();
    expect(
      first.getByRole("link", { name: /^Open the run/ }).getAttribute("href"),
    ).toBe("/w/acme/workflows/wf-1/runs/run-1");
  });

  // #1080-T31
  it("asks for the runs of this lane again while one is active, and keeps to the lane", async () => {
    const { listWorkspace } = renderInLane(page([item()]));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS);
    });

    expect(listWorkspace).toHaveBeenCalledWith({ lane: "wf-1" });
  });

  // #1080-T32
  it("says that the lane has not run yet, not that a filter matched nothing, and promises the Start form only where it is offered", () => {
    renderInLane(page([]), true);
    expect(screen.getByText(LANE_RUNS_COPY.emptyInLaneStartable)).toBeTruthy();
    expect(screen.queryByText(LANE_RUNS_COPY.emptyFiltered)).toBeNull();
    cleanup();

    // A member who may not start, or an archived lane (the page offers no start): no promise of the button.
    renderInLane(page([]), false);
    expect(screen.getByText(LANE_RUNS_COPY.emptyInLane)).toBeTruthy();
    expect(LANE_RUNS_COPY.emptyInLane).not.toContain("form");
    expect(screen.queryByText(LANE_RUNS_COPY.emptyInLaneStartable)).toBeNull();
  });

  // #1080-T33
  it("has no column for the lane and the project, which are the page's own, and still shows what started each run", () => {
    renderInLane(
      page([
        item(),
        item({ id: "run-2", trigger: "manual", actorLogin: "grace" }),
      ]),
    );

    const headers = screen
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers).not.toContain(LANE_RUNS_COPY.columnLane);
    expect(headers).not.toContain(LANE_RUNS_COPY.columnProject);
    expect(headers).toContain(LANE_RUNS_COPY.columnTrigger);
    const [first, second] = screen
      .getAllByRole("row")
      .filter((row) => row.hasAttribute("data-run-id"));
    expect(within(first as HTMLElement).getByText("ada")).toBeTruthy();
    expect(
      within(first as HTMLElement).getByText("A label on a ticket"),
    ).toBeTruthy();
    // By hand: the trigger, not a second line with the login.
    expect(
      within(second as HTMLElement).getByText("Started by hand"),
    ).toBeTruthy();
    expect(within(second as HTMLElement).queryByText("grace")).toBeNull();
  });
});
