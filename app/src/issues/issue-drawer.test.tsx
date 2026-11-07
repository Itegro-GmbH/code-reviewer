// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The issue drawer (#925): GitHub's own words for state, type, labels, board status, assignees, the pull request and its checks; the lane,
// the effort and the history from the factory; the sub-issues and the technical section. A field the data does not have is left out.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run, step } from "../workflow-pages/test-fixtures.ts";
import type { IssuesApi } from "./api.ts";
import { IssueDrawer } from "./issue-drawer.tsx";
import { ticket, ticketList } from "./test-fixtures.ts";

afterEach(cleanup);

const LANE = {
  runId: "run-1",
  workflowId: "wf-1",
  name: "Issue to PR",
  step: "implement",
  status: "waiting" as const,
};

function apiWith(result: Awaited<ReturnType<IssuesApi["run"]>>): IssuesApi {
  return { list: vi.fn(), run: vi.fn(async () => result) };
}

const FULL = ticket(12, {
  title: "Cache the catalog",
  type: "Bug",
  labels: [
    { name: "agent implement", color: "ededed" },
    { name: "perf", color: "ededed" },
  ],
  assignees: [{ login: "octocat" }, { login: "hubot" }],
  boardStatus: "In review",
  pullRequests: [20],
  lane: LANE,
  costUsd: 1.5,
});

const LIST = ticketList([
  FULL,
  ticket(20, { kind: "pull_request", state: "open", checksState: "failure" }),
  ticket(13, { parentNumber: 12, title: "Sub task", state: "closed" }),
]);

function open(
  item = FULL,
  api: IssuesApi = apiWith({ ok: false, status: 500, code: "X", issues: [] }),
  onClose = vi.fn(),
) {
  render(
    <IssueDrawer
      workspaceSlug="acme"
      repositoryId="repo-1"
      projectId="p-1"
      list={LIST}
      item={item}
      onClose={onClose}
      api={api}
    />,
  );
  return { onClose };
}

describe("the issue drawer", () => {
  // #925-T25
  it("shows GitHub's words for state, type, labels, board status and assignees, the pull request with its checks and the sub-issues", () => {
    open();

    const drawer = screen.getByRole("dialog", { name: /Cache the catalog/ });
    expect(within(drawer).getByText("Bug")).toBeTruthy();
    expect(within(drawer).getByText("In review")).toBeTruthy();
    expect(within(drawer).getByText("octocat, hubot")).toBeTruthy();
    expect(within(drawer).getByText("agent implement")).toBeTruthy();
    expect(
      within(drawer).getByRole("link", { name: "#20" }).getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/pull/20");
    expect(within(drawer).getByText(/Checks: failure/)).toBeTruthy();
    expect(within(drawer).getByText("Sub task")).toBeTruthy();
    expect(
      within(drawer)
        .getByRole("link", { name: "Open on GitHub" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/issues/12");
  });

  // #925-T26
  it("says what is missing instead of inventing it", () => {
    open(ticket(5), apiWith({ ok: false, status: 500, code: "X", issues: [] }));

    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("No lane is on this issue.")).toBeTruthy();
    expect(within(drawer).getByText("none yet")).toBeTruthy();
    expect(within(drawer).getByText("nobody")).toBeTruthy();
    expect(within(drawer).getByText("$0.00")).toBeTruthy();
    // There are no tokens or lines of code in the data: the fields are not there.
    expect(within(drawer).queryByText(/token/i)).toBeNull();
    expect(within(drawer).queryByText(/lines/i)).toBeNull();
  });

  // #925-T27
  it("shows the lane, its step and the run's rounds, questions and history once the run is read", async () => {
    const view = run({
      id: "run-1",
      status: "waiting",
      steps: [
        step({ id: "plan", position: 0 }),
        step({
          id: "implement",
          position: 1,
          status: "waiting",
          round: 2,
          ask: { status: "open" } as never,
          startedAt: "2026-11-05T11:00:00.000Z",
        }),
      ],
    });
    const api = apiWith({ ok: true, data: { run: view } });
    open(FULL, api);

    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("Issue to PR")).toBeTruthy();
    expect(within(drawer).getByText("waits for an answer")).toBeTruthy();
    expect(
      within(drawer)
        .getByRole("link", { name: "Open the run" })
        .getAttribute("href"),
    ).toBe("/w/acme/workflows/wf-1/runs/run-1");
    await waitFor(() =>
      expect(within(drawer).getByText("Questions")).toBeTruthy(),
    );
    expect(api.run).toHaveBeenCalledWith("wf-1", "run-1");
    expect(
      within(drawer).getByRole("heading", { name: "History" }),
    ).toBeTruthy();
    expect(within(drawer).getByText("round 2")).toBeTruthy();
  });

  // #925-T28
  it("keeps the rest of the drawer when the run cannot be read", async () => {
    open(
      FULL,
      apiWith({
        ok: false,
        status: 404,
        code: "WORKFLOW_RUN_NOT_FOUND",
        issues: [],
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByText("The run could not be read right now."),
      ).toBeTruthy(),
    );
    expect(screen.getByText("In review")).toBeTruthy();
  });

  // #925-T29
  it("lists the technical ids and the times, and closes on Escape", async () => {
    const { onClose } = open();

    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("github:acme/widgets#12")).toBeTruthy();
    expect(within(drawer).getByText("p-1")).toBeTruthy();
    expect(within(drawer).getByText(/repo-1/)).toBeTruthy();

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  // #925-T30
  it("is closed while no issue is chosen", () => {
    render(
      <IssueDrawer
        workspaceSlug="acme"
        repositoryId="repo-1"
        projectId="p-1"
        list={LIST}
        item={undefined}
        onClose={() => undefined}
        api={apiWith({ ok: false, status: 500, code: "X", issues: [] })}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
