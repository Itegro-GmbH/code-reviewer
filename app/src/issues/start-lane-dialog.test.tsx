// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The start dialog (#925): one question, "Which lane?", the lane's facts and limits, and the start through the lane's start route with the
// issue as the ticket. No machine, profile or model is asked.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunsApi } from "../workflow-pages/api.ts";
import { run } from "../workflow-pages/test-fixtures.ts";
import { START_LANE_COPY } from "./messages.ts";
import { StartLaneDialog } from "./start-lane-dialog.tsx";
import { LANE } from "./test-fixtures.ts";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));

afterEach(() => {
  cleanup();
  navigation.push.mockClear();
});

function apiWith(start: WorkflowRunsApi["start"]): WorkflowRunsApi {
  return { start } as unknown as WorkflowRunsApi;
}

const OTHER = {
  ...LANE,
  workflowId: "wf-2",
  name: "Quick fix",
  trigger: "go",
  budgetUsd: 2.5,
  turnTimeLimitMinutes: 15,
  description: "",
  firstSteps: [],
};

describe("the start dialog", () => {
  // #925-T20
  it("asks only which lane, and says what the chosen lane does and its limits", async () => {
    render(
      <StartLaneDialog
        workspaceSlug="acme"
        repo="acme/widgets"
        issueNumber={7}
        lanes={[LANE, OTHER]}
        onOpenChange={() => undefined}
        api={apiWith(vi.fn())}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "Start a lane on issue #7",
    });
    expect(
      within(dialog).getByRole("radiogroup", { name: "Which lane?" }),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("value")),
    ).toEqual(["wf-1", "wf-2"]);
    expect(within(dialog).getByText(LANE.description)).toBeTruthy();
    expect(within(dialog).getByText("Action: ticket.labels")).toBeTruthy();
    expect(
      within(dialog).getByText("Budget $20 · 60 min per agent turn"),
    ).toBeTruthy();
    // Nothing about a machine, a profile or a model.
    expect(
      within(dialog).queryByText(/machine|profile|model|runner/i),
    ).toBeNull();

    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Quick fix" }),
    );

    expect(
      within(dialog).getByText("Budget $2.50 · 15 min per agent turn"),
    ).toBeTruthy();
    expect(within(dialog).queryByText(LANE.description)).toBeNull();
  });

  // #925-T21
  it("starts the chosen lane through its start route with the issue as the ticket and opens the run", async () => {
    const start = vi.fn(async () => ({
      ok: true as const,
      data: { run: run({ id: "run-9", workflowId: "wf-1" }) },
    }));
    const onOpenChange = vi.fn();
    render(
      <StartLaneDialog
        workspaceSlug="acme"
        repo="acme/widgets"
        issueNumber={7}
        lanes={[LANE]}
        onOpenChange={onOpenChange}
        api={apiWith(start)}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: START_LANE_COPY.start }),
    );

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledWith("wf-1", {
      trigger: "manual",
      input: { ticket: "github:acme/widgets#7" },
      clientRequestId: expect.any(String),
    });
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(
        "/w/acme/workflows/wf-1/runs/run-9",
      ),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // #925-T22
  it("keeps the same request id for a retry after a refusal and says why in a sentence", async () => {
    const start = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        code: "WORKFLOW_RUN_TICKET_OUTSIDE_PROJECT",
        issues: [],
      })
      .mockResolvedValueOnce({
        ok: false,
        status: null,
        code: "NETWORK_ERROR",
        issues: [],
      });
    render(
      <StartLaneDialog
        workspaceSlug="acme"
        repo="acme/widgets"
        issueNumber={7}
        lanes={[LANE]}
        onOpenChange={() => undefined}
        api={apiWith(start)}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: START_LANE_COPY.start }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Starting" }).textContent,
      ).not.toBe(""),
    );
    await userEvent.click(
      screen.getByRole("button", { name: START_LANE_COPY.start }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));

    const ids = start.mock.calls.map(
      (call) => (call[1] as { clientRequestId: string }).clientRequestId,
    );
    expect(ids[0]).toBe(ids[1]);
    expect(navigation.push).not.toHaveBeenCalled();
    expect(
      screen.getByRole("status", { name: "Starting" }).textContent,
    ).not.toMatch(/WORKFLOW_RUN|NETWORK_ERROR/);
  });

  // #925-T23
  it("says there is no lane to start, and offers no start, when the project has none", () => {
    render(
      <StartLaneDialog
        workspaceSlug="acme"
        repo="acme/widgets"
        issueNumber={7}
        lanes={[]}
        onOpenChange={() => undefined}
        api={apiWith(vi.fn())}
      />,
    );

    expect(screen.getByText(START_LANE_COPY.none)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: START_LANE_COPY.start,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  // #925-T24
  it("is closed while no issue is chosen, and closes on Escape", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <StartLaneDialog
        workspaceSlug="acme"
        repo="acme/widgets"
        issueNumber={null}
        lanes={[LANE]}
        onOpenChange={onOpenChange}
        api={apiWith(vi.fn())}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(
      <StartLaneDialog
        workspaceSlug="acme"
        repo="acme/widgets"
        issueNumber={3}
        lanes={[LANE]}
        onOpenChange={onOpenChange}
        api={apiWith(vi.fn())}
      />,
    );
    await userEvent.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // #925-T50
  it("sends one request for a double click on Start", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const start = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <StartLaneDialog
        workspaceSlug="acme"
        repo="acme/widgets"
        issueNumber={7}
        lanes={[LANE]}
        onOpenChange={() => undefined}
        api={apiWith(start as unknown as WorkflowRunsApi["start"])}
      />,
    );
    const button = screen.getByRole("button", { name: START_LANE_COPY.start });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(
      screen.getByRole("button", { name: START_LANE_COPY.starting }),
    );

    expect(start).toHaveBeenCalledTimes(1);
    finish({ ok: true, data: { run: run({ id: "run-9" }) } });
    await waitFor(() => expect(navigation.push).toHaveBeenCalledTimes(1));
  });
});
