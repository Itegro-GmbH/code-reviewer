// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the list of runs: what a table row shows, the empty states, the capped footer, text from
// outside rendered as text, and the polling (the status moves on without a reload; a failed update
// keeps the last data).
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { RunRowView, RunsSnapshot } from "../run-view.ts";
import type { RunsApi } from "./api.ts";
import { ProductIdentityProvider } from "../../product-identity/context.tsx";
import { identityFor } from "../../product-identity/identities.ts";
import { POLL_FAILED_TEXT } from "./poll-messages.ts";
import { RunsList } from "./runs-list.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function run(overrides: Partial<RunRowView> = {}): RunRowView {
  return {
    id: "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11",
    repositoryId: "repo-1",
    project: "acme/widgets",
    prNumber: 7,
    prUrl: "https://github.com/acme/widgets/pull/7",
    command: "review",
    reviewKind: "diff",
    triggerKind: "webhook",
    trigger: "Automatic",
    status: "succeeded",
    createdAt: "2026-10-10T12:00:00.000Z",
    startedAt: "2026-10-10T12:00:10.000Z",
    finishedAt: "2026-10-10T12:01:00.000Z",
    durationMs: 50_000,
    problem: null,
    ...overrides,
  };
}

function snapshot(
  runs: RunRowView[],
  overrides: Partial<RunsSnapshot> = {},
): RunsSnapshot {
  return {
    generatedAt: "2026-10-10T12:10:00.000Z",
    runs,
    limited: false,
    ...overrides,
  };
}

/** The data rows of the runs table, without its header row. */
function dataRows(): HTMLElement[] {
  return within(screen.getByRole("table", { name: "Runs" }))
    .getAllByRole("row")
    .slice(1);
}

function apiAnswering(
  answers: RequestResult<RunsSnapshot>[],
): RunsApi & { list: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => answers.shift() ?? failure),
    detail: vi.fn(),
  } as RunsApi & { list: ReturnType<typeof vi.fn> };
}

const failure: RequestResult<RunsSnapshot> = {
  ok: false,
  status: 500,
  code: "UNEXPECTED_RESPONSE",
  issues: [],
};
const answer = (data: RunsSnapshot): RequestResult<RunsSnapshot> => ({
  ok: true,
  data,
});

describe("the review kind in the list", () => {
  // #200
  it("marks a Dynamic Review run with a small badge and leaves the default Diff Review runs unmarked", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([
          run({ id: "diff-run" }),
          run({ id: "dynamic-run", reviewKind: "dynamic" }),
        ])}
        filter={{}}
        api={apiAnswering([])}
      />,
    );

    const [diff, dynamic] = dataRows();
    expect(
      within(diff as HTMLElement).queryByText("Dynamic Review"),
    ).toBeNull();
    expect(
      within(dynamic as HTMLElement).getByText("Dynamic Review"),
    ).toBeTruthy();
  });

  // #200
  it("shows the sentence of a Dynamic code in the row of a run that failed with it", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([
          run({
            reviewKind: "dynamic",
            status: "failed",
            problem: "Dynamic Review is not switched on yet.",
          }),
        ])}
        filter={{}}
        api={apiAnswering([])}
      />,
    );

    expect(
      within(dataRows()[0] as HTMLElement).getByText(/not switched on/),
    ).toBeTruthy();
  });
});

describe("the rows of the list", () => {
  // CR-35-T01
  it("show project, pull request, command, status and start time, each run linking to its page", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([
          run(),
          run({
            id: "other-run",
            project: "acme/gadgets",
            prNumber: 9,
            command: "improve",
            status: "failed",
            problem:
              "The run took longer than the time limit, so it was stopped.",
            triggerKind: "comment",
            trigger: "Comment by alice",
          }),
        ])}
        filter={{}}
        api={apiAnswering([])}
      />,
    );

    const rows = dataRows();
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first?.textContent).toContain("acme/widgets");
    expect(first?.textContent).toContain("#7");
    expect(first?.textContent).toContain("/review");
    expect(first?.textContent).toContain("Succeeded");
    expect(first?.textContent).toContain("2026-10-10 12:00 UTC");
    expect(second?.textContent).toContain("acme/gadgets");
    expect(second?.textContent).toContain("/improve");
    expect(second?.textContent).toContain("Comment by alice");
    expect(second?.textContent).toContain("Failed");
    expect(second?.textContent).toContain("time limit");
    expect(
      within(first as HTMLElement)
        .getByRole("link", { name: "acme/widgets #7" })
        .getAttribute("href"),
    ).toBe("/w/acme/runs/6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11");
  });

  // #175 review: two runs of one project must be told apart in a screen reader's link list.
  it("names each run link with its project and pull request", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([
          run({ id: "a", prNumber: 7 }),
          run({ id: "b", prNumber: 9 }),
        ])}
        filter={{}}
        api={apiAnswering([])}
      />,
    );

    const links = screen.getAllByRole("link", { name: /^acme\/widgets #/ });
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
      "acme/widgets #7",
      "acme/widgets #9",
    ]);
    expect(new Set(links.map((link) => link.getAttribute("href"))).size).toBe(
      2,
    );
  });

  it("tell a waiting run from one that started, and show how long a run took", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([
          run({
            id: "a",
            status: "queued",
            startedAt: null,
            finishedAt: null,
            durationMs: null,
          }),
          run({
            id: "b",
            status: "running",
            finishedAt: null,
            durationMs: 125_000,
          }),
          run({ id: "c", status: "succeeded", durationMs: 185_000 }),
        ])}
        filter={{}}
        api={apiAnswering([])}
      />,
    );

    const [waiting, going, done] = dataRows();
    expect(waiting?.textContent).toContain(
      "Waiting since 2026-10-10 12:00 UTC",
    );
    expect(waiting?.textContent).not.toContain("Took");
    expect(going?.textContent).toContain("Running for 2 min 05 s");
    expect(done?.textContent).toContain("Took 3 min 05 s");
  });

  // #175-T02
  it("says the list is capped in a footer line, not in a row", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([run()], { limited: true })}
        filter={{}}
        api={apiAnswering([])}
      />,
    );

    const note = screen.getByText(/Only the newest 1 runs are shown/);
    expect(note.tagName).toBe("P");
    expect(note.closest("table")).toBeNull();
    expect(dataRows()).toHaveLength(1);
  });

  // CR-35-T13
  it("render a project name and a login with HTML as text and run no script", () => {
    const { container } = render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([
          run({
            project: "<script>alert(1)</script>/<img src=x onerror=alert(1)>",
            trigger: "Comment by <b>mallory</b>",
          }),
        ])}
        filter={{}}
        api={apiAnswering([])}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain("Comment by <b>mallory</b>");
  });
});

describe("the empty list", () => {
  // CR-35-T03
  it("explains that there are no runs yet and offers one action", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([])}
        filter={{}}
        api={apiAnswering([])}
      />,
    );

    expect(screen.getByRole("heading", { name: "No runs yet" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open projects" }).getAttribute("href"),
    ).toBe("/w/acme/projects");
    expect(screen.queryByRole("table")).toBeNull();
  });

  // #757-T02
  it("offers the factory the QA area under its own name", () => {
    render(
      <ProductIdentityProvider product={identityFor("factory")}>
        <RunsList
          workspaceSlug="acme"
          initial={snapshot([])}
          filter={{}}
          api={apiAnswering([])}
        />
      </ProductIdentityProvider>,
    );

    expect(
      screen.getByRole("link", { name: "Open QA" }).getAttribute("href"),
    ).toBe("/w/acme/projects");
    expect(screen.queryByRole("link", { name: "Open projects" })).toBeNull();
  });

  // CR-35-T03
  it("explains that no run matches the filter and offers to reset it", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([])}
        filter={{ status: "failed" }}
        api={apiAnswering([])}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "No runs for this filter" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Reset filter" }).getAttribute("href"),
    ).toBe("/w/acme/runs");
  });
});

describe("polling the list", () => {
  async function pass(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  // CR-35-T11
  it("moves a waiting run to running and succeeded without a reload", async () => {
    const waiting = run({
      status: "queued",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    });
    const api = apiAnswering([
      answer(
        snapshot([
          { ...waiting, status: "running", startedAt: waiting.createdAt },
        ]),
      ),
      answer(snapshot([run({ id: waiting.id })])),
    ]);
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([waiting])}
        filter={{}}
        api={api}
      />,
    );
    expect(screen.getByText("Waiting")).toBeTruthy();

    await pass(3000);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByText("Waiting")).toBeNull();

    await pass(3000);
    expect(screen.getByText("Succeeded")).toBeTruthy();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  // CR-35-T11
  it("slows down once every run is settled instead of asking every few seconds", async () => {
    const api = apiAnswering([answer(snapshot([run()]))]);
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([run()])}
        filter={{}}
        api={api}
      />,
    );

    await pass(4000);
    expect(api.list).not.toHaveBeenCalled();
    await pass(1000);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  // CR-35-T17
  it("shows a run that appears after the page was opened", async () => {
    const api = apiAnswering([
      answer(
        snapshot([
          run({
            id: "new",
            status: "queued",
            startedAt: null,
            finishedAt: null,
            durationMs: null,
          }),
        ]),
      ),
    ]);
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([])}
        filter={{}}
        api={api}
      />,
    );
    expect(screen.getByText("No runs yet")).toBeTruthy();

    await pass(5000);

    expect(screen.queryByText("No runs yet")).toBeNull();
    expect(screen.getByText("Waiting")).toBeTruthy();
  });

  // CR-35-T12
  it("keeps the last data, says the update failed and goes on with the next try", async () => {
    const waiting = run({
      status: "queued",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    });
    const api = apiAnswering([
      failure,
      answer(snapshot([run({ id: waiting.id })])),
    ]);
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([waiting])}
        filter={{}}
        api={api}
      />,
    );

    await pass(3000);
    expect(screen.getByRole("status").textContent).toBe(POLL_FAILED_TEXT);
    expect(screen.getByText("Waiting")).toBeTruthy();

    await pass(3000);
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByText("Succeeded")).toBeTruthy();
  });

  it("asks with the filter of its address", async () => {
    const api = apiAnswering([answer(snapshot([]))]);
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([])}
        filter={{ repositoryId: "repo-1", status: "failed" }}
        api={api}
      />,
    );

    await pass(5000);

    expect(api.list).toHaveBeenCalledWith({
      repositoryId: "repo-1",
      status: "failed",
    });
  });
});

describe("the price of a review in the list (#505)", () => {
  // #505-T05
  it("adds a Price column with the two prices of a charged review and Not charged for a free one", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([
          run({
            id: "charged-run",
            price: {
              state: "charged",
              aiMicroUsd: 1_500_000,
              infraMicroUsd: 130_000,
            },
          }),
          run({ id: "free-run", price: { state: "not_charged" } }),
          run({ id: "open-run" }),
        ])}
        filter={{}}
        api={apiAnswering([])}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Price" })).toBeTruthy();
    const [charged, free, open] = dataRows();
    expect(within(charged as HTMLElement).getByText("$1.50")).toBeTruthy();
    expect(within(charged as HTMLElement).getByText("$0.13")).toBeTruthy();
    expect(within(free as HTMLElement).getByText("Not charged")).toBeTruthy();
    expect(within(open as HTMLElement).queryByText("Not charged")).toBeNull();
  });

  // #505-T11
  it("adds no column while no run has a price, as when billing is off", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={snapshot([run({ id: "a" }), run({ id: "b" })])}
        filter={{}}
        api={apiAnswering([])}
      />,
    );

    expect(screen.queryByRole("columnheader", { name: "Price" })).toBeNull();
  });
});
