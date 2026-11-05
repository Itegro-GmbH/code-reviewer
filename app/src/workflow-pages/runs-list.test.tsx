// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The list of the runs of a workflow (#873): status, start, trigger, what was spent of the budget, the version, a failure told in
// words, a link to each run, and the polling that runs while a run runs and stops after.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../ui/json-request.ts";
import type { RunSummaryView } from "../workflow-runs/service.ts";
import { WORKFLOW_RUN_POLL_MS, type WorkflowRunsApi } from "./api.ts";
import { PAGE_COPY } from "./messages.ts";
import { WorkflowRunsList } from "./runs-list.tsx";
import { summary } from "./test-fixtures.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ok = (
  runs: RunSummaryView[],
): RequestResult<{ runs: RunSummaryView[] }> => ({
  ok: true,
  data: { runs },
});

function renderList(
  runs: RunSummaryView[],
  answers: RequestResult<{ runs: RunSummaryView[] }>[] = [],
) {
  const api = {
    list: vi.fn(
      async () =>
        answers.shift() ??
        ({
          ok: false,
          status: 500,
          code: "UNEXPECTED_RESPONSE",
          issues: [],
        } as const),
    ),
  } as unknown as WorkflowRunsApi & { list: ReturnType<typeof vi.fn> };
  const view = render(
    <WorkflowRunsList
      workspaceSlug="acme"
      workflowId="wf-1"
      initial={{ runs }}
      api={api}
    />,
  );
  return { ...view, api };
}

describe("the list of runs", () => {
  // #873-T60
  it("shows status, start, trigger, spent of the budget and version of each run, newest first as given", () => {
    const { container } = renderList([
      summary({
        id: "run-2",
        status: "succeeded",
        spentUsd: 1.25,
        budgetUsd: 5,
        workflowVersion: 4,
        finishedAt: "2026-11-05T11:00:00.000Z",
        createdAt: "2026-11-05T10:30:00.000Z",
      }),
      summary({
        id: "run-1",
        status: "failed",
        errorCode: "budget_exhausted",
        finishedAt: "2026-11-05T10:20:00.000Z",
      }),
    ]);

    const rows = container.querySelectorAll("tbody tr");
    expect([...rows].map((row) => row.getAttribute("data-run-id"))).toEqual([
      "run-2",
      "run-1",
    ]);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText("Succeeded")).toBeTruthy();
    expect(first.getByText("2026-11-05 10:30 UTC")).toBeTruthy();
    expect(first.getByText("Started by hand")).toBeTruthy();
    expect(first.getByText("$1.25 of $5.00")).toBeTruthy();
    expect(first.getByText("4")).toBeTruthy();
    const second = within(rows[1] as HTMLElement);
    expect(second.getByText("Failed")).toBeTruthy();
    expect(rows[1]?.textContent).toContain("budget of the run is used up");
    expect(container.textContent).not.toContain("budget_exhausted");
  });

  // #873-T60
  it("links each run to its page in the workspace", () => {
    renderList([summary({ id: "run-2" })]);

    const link = screen.getByRole("link", {
      name: new RegExp(PAGE_COPY.openRun),
    });
    expect(link.getAttribute("href")).toBe("/w/acme/workflows/wf-1/runs/run-2");
  });

  // #873-T61
  it("says that the workflow has not run yet", () => {
    renderList([]);

    expect(screen.getByText(PAGE_COPY.runsEmpty)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("while a run runs", () => {
  // #873-T62
  it("asks again, shows the newer list, and stops when no run runs", async () => {
    const { api, container } = renderList(
      [summary({ id: "run-1", status: "running" })],
      [
        ok([
          summary({
            id: "run-1",
            status: "succeeded",
            finishedAt: "2026-11-05T10:20:00.000Z",
          }),
        ]),
      ],
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
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledWith("wf-1");
  });

  // #873-T62
  it("does not ask when every run has ended", async () => {
    const { api } = renderList([
      summary({ status: "succeeded", finishedAt: "2026-11-05T10:20:00.000Z" }),
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS * 5);
    });
    expect(api.list).not.toHaveBeenCalled();
  });
});
