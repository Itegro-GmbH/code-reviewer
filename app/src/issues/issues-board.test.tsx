// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The Issues tab (#925): the table of the prototype with real data (the issue with its number, type and labels; GitHub's state and board
// status; the lane and its step; what it waits for with Start, Answer and Review), the tiles, the filter, the drawer a click opens and the
// start dialog the Start button opens.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ISSUES_POLL, type IssuesApi } from "./api.ts";
import { IssuesBoard } from "./issues-board.tsx";
import { LANE, ticket, ticketList } from "./test-fixtures.ts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const RUNNING = {
  runId: "run-1",
  workflowId: "wf-1",
  name: "Issue to PR",
  step: "implement",
  status: "running" as const,
};

const LIST = ticketList([
  ticket(1, {
    title: "Add caching",
    type: "Feature",
    labels: [{ name: "perf", color: "ededed" }],
    boardStatus: "Todo",
  }),
  ticket(2, { title: "Fix crash", lane: RUNNING, costUsd: 2 }),
  ticket(3, {
    title: "Which db?",
    lane: { ...RUNNING, runId: "run-3", status: "waiting", step: "plan" },
  }),
  ticket(4, {
    title: "Ready to merge",
    pullRequests: [14],
    boardStatus: "In review",
  }),
  ticket(5, { title: "Old thing", state: "closed", stateReason: "completed" }),
  ticket(14, { kind: "pull_request", title: "Pull request of 4" }),
]);

const api: IssuesApi = {
  list: vi.fn(async () => ({ ok: true as const, data: LIST })),
  run: vi.fn(async () => ({
    ok: false as const,
    status: 500,
    code: "X",
    issues: [],
  })),
};

function board(props: Partial<React.ComponentProps<typeof IssuesBoard>> = {}) {
  return render(
    <IssuesBoard
      workspaceSlug="acme"
      repositoryId="repo-1"
      projectId="p-1"
      initial={LIST}
      lanes={[LANE]}
      mayStart
      api={api}
      {...props}
    />,
  );
}

const rowOf = (number: number) =>
  screen
    .getByRole("table", { name: "Issues" })
    .querySelector(`[data-issue="${String(number)}"]`) as HTMLElement;

describe("the Issues tab", () => {
  // #925-T31
  it("shows the open issues with GitHub's words, the lane and its step, and no pull request as a row", () => {
    board();

    const table = screen.getByRole("table", { name: "Issues" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Issue", "In GitHub", "Lane", "Waits for"]);
    expect(rowOf(14)).toBeNull();
    expect(rowOf(5)).toBeNull();
    const first = within(rowOf(1));
    expect(first.getByText("Add caching")).toBeTruthy();
    expect(first.getByText("Feature")).toBeTruthy();
    expect(first.getByText("perf")).toBeTruthy();
    expect(first.getByText("open")).toBeTruthy();
    expect(first.getByText("Todo")).toBeTruthy();
    expect(first.getByText("No lane")).toBeTruthy();
    const second = within(rowOf(2));
    expect(second.getByText("Issue to PR")).toBeTruthy();
    expect(second.getByText("at implement")).toBeTruthy();
  });

  // #925-T32
  it("shows Start, Answer and Review where an issue waits for them, and nothing where a lane works", () => {
    board();

    expect(
      within(rowOf(1)).getByRole("button", {
        name: "Start a lane on issue #1",
      }),
    ).toBeTruthy();
    expect(
      within(rowOf(2)).queryByRole("button", { name: /Start a lane/ }),
    ).toBeNull();
    expect(
      within(rowOf(2)).queryByRole("link", { name: /Answer|Review/ }),
    ).toBeNull();
    expect(within(rowOf(2)).getByText("–")).toBeTruthy();
    expect(
      within(rowOf(3))
        .getByRole("link", { name: "Answer the question on issue #3" })
        .getAttribute("href"),
    ).toBe("/w/acme/projects/repo-1/todos?run=run-3");
    expect(
      within(rowOf(4))
        .getByRole("link", {
          name: "Review the pull request of issue #4 on GitHub",
        })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/pull/14");
  });

  // #925-T33
  it("fills the tiles from the data", () => {
    board();

    const tile = (name: string) =>
      screen
        .getAllByRole("listitem")
        .find((item) => item.textContent?.startsWith(name)) as HTMLElement;
    expect(within(tile("Open issues")).getByText("4")).toBeTruthy();
    expect(within(tile("Lanes working")).getByText("2")).toBeTruthy();
    expect(within(tile("Wait for you")).getByText("2")).toBeTruthy();
    expect(
      within(tile("Spent on these issues")).getByText("$2.00"),
    ).toBeTruthy();
  });

  // #925-T34
  it("shows the closed issues when asked", async () => {
    board();

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Show" }),
      "all",
    );

    expect(within(rowOf(5)).getByText("closed")).toBeTruthy();
  });

  // #925-T35
  it("opens the drawer of an issue from its row and closes it again with Escape", async () => {
    board();

    await userEvent.click(
      within(rowOf(4)).getByRole("button", { name: "#4 Ready to merge" }),
    );

    const drawer = await screen.findByRole("dialog", {
      name: /Ready to merge/,
    });
    expect(within(drawer).getByText("In review")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // #925-T36
  it("opens the start dialog from Start, for that issue", async () => {
    board();

    await userEvent.click(
      within(rowOf(1)).getByRole("button", {
        name: "Start a lane on issue #1",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Start a lane on issue #1",
    });
    expect(
      within(dialog).getByRole("radio", { name: "Issue to PR" }),
    ).toBeTruthy();
  });

  // #925-T37
  it("keeps a refused Start focusable and says why in words a screen reader reads, for a person who may not start and for a project without a lane", async () => {
    board({ mayStart: false });
    const denied = within(rowOf(1)).getByRole("button", {
      name: "Start a lane on issue #1",
    }) as HTMLButtonElement;
    expect(denied.disabled).toBe(false);
    expect(denied.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(denied.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toMatch(/may start/);
    await userEvent.click(denied);
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();

    board({ lanes: [] });
    const none = within(rowOf(1)).getByRole("button", {
      name: "Start a lane on issue #1",
    }) as HTMLButtonElement;
    expect(none.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(none.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toMatch(/no lane/);
  });

  // #925-T38
  it("keeps the empty state of the prototype while the tickets are not mirrored", () => {
    board({ initial: null });

    expect(screen.getByText("No issues yet")).toBeTruthy();
    expect(screen.getAllByText("–").length).toBe(4);
    expect(
      screen.getByText(/Nothing is translated: state, type, labels/),
    ).toBeTruthy();
  });

  // #925-T39
  it("says there are no open issues when only closed ones exist", () => {
    board({ initial: ticketList([ticket(5, { state: "closed" })]) });

    expect(screen.getByText("No open issues")).toBeTruthy();
  });

  // #925-T43
  it("returns the focus to the row's button when the drawer closes, with Escape and with its close button", async () => {
    board();
    const opener = within(rowOf(4)).getByRole("button", {
      name: "#4 Ready to merge",
    });

    await userEvent.click(opener);
    await screen.findByRole("dialog", { name: /Ready to merge/ });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);

    await userEvent.click(opener);
    const drawer = await screen.findByRole("dialog", {
      name: /Ready to merge/,
    });
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Close" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  // #925-T44
  it("returns the focus to the Start button when the start dialog is cancelled or closed with Escape", async () => {
    board();
    const opener = within(rowOf(1)).getByRole("button", {
      name: "Start a lane on issue #1",
    });

    await userEvent.click(opener);
    await screen.findByRole("dialog", { name: "Start a lane on issue #1" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);

    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", {
      name: "Start a lane on issue #1",
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  // #925-T45
  it("offers Review only for an open pull request: a closed one leaves Start", () => {
    board({
      initial: ticketList([
        ticket(4, { pullRequests: [14] }),
        ticket(14, { kind: "pull_request", state: "closed" }),
      ]),
    });

    expect(within(rowOf(4)).queryByRole("link", { name: /Review/ })).toBeNull();
    expect(
      within(rowOf(4)).getByRole("button", {
        name: "Start a lane on issue #4",
      }),
    ).toBeTruthy();
  });

  // #925-T46
  it("keeps the drawer on the issue when a later list no longer holds it", async () => {
    const { rerender } = board();
    await userEvent.click(
      within(rowOf(4)).getByRole("button", { name: "#4 Ready to merge" }),
    );
    await screen.findByRole("dialog", { name: /Ready to merge/ });

    rerender(
      <IssuesBoard
        workspaceSlug="acme"
        repositoryId="repo-1"
        projectId="p-1"
        initial={ticketList([ticket(1, { title: "Add caching" })])}
        lanes={[LANE]}
        mayStart
        api={api}
      />,
    );

    expect(screen.getByRole("dialog", { name: /Ready to merge/ })).toBeTruthy();
    // The drawer is portalled: close it so that it does not outlive the test.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // #925-T47
  it("says on the tiles that they count the issues loaded, and how many of the repository's that are", () => {
    board();
    expect(screen.getByText(/Counted over all 5 issues/)).toBeTruthy();
    cleanup();

    board({
      initial: ticketList(
        Array.from({ length: 200 }, (_, index) => ticket(index + 1)),
      ),
    });
    expect(
      screen.getByText(/Counted over the 200 tickets that changed last/),
    ).toBeTruthy();
  });

  // #954
  it("counts the tiles over all issues at 199 tickets and says the list is limited at 200, in tickets", () => {
    board({
      initial: ticketList(
        Array.from({ length: 199 }, (_, index) => ticket(index + 1)),
      ),
    });
    expect(screen.getByText(/Counted over all 199 issues/)).toBeTruthy();
    expect(screen.queryByText(/changed last/)).toBeNull();
    cleanup();

    board({
      initial: ticketList(
        Array.from({ length: 200 }, (_, index) => ticket(index + 1)),
      ),
    });
    expect(screen.getByText(/Counted over the 200 tickets/)).toBeTruthy();
    expect(
      screen.getByText(
        "Showing the 200 tickets that changed last (issues and pull requests).",
      ),
    ).toBeTruthy();
  });

  // #954
  it("says why Start is refused once, in a banner every refused Start points at, not in every row", () => {
    board({
      mayStart: false,
      initial: ticketList([ticket(1), ticket(2), ticket(3)]),
    });

    const banner = screen.getAllByText(/may start/);
    expect(banner).toHaveLength(1);
    const starts = screen.getAllByRole("button", { name: /Start a lane/ });
    expect(starts).toHaveLength(3);
    for (const start of starts) {
      expect(start.getAttribute("aria-describedby")).toBe(banner[0]?.id);
      expect(start.getAttribute("aria-disabled")).toBe("true");
    }
    expect(within(rowOf(1)).queryByText(/may start/)).toBeNull();
  });

  // #954
  it("shows no banner where Start is not refused or nothing waits for a start", () => {
    board();
    expect(screen.queryByText(/may start/)).toBeNull();
    cleanup();

    board({
      mayStart: false,
      initial: ticketList([ticket(2, { lane: RUNNING })]),
    });
    expect(screen.queryByText(/may start/)).toBeNull();
  });

  // #954
  it.each(["{Enter}", " "])(
    "does not open the start dialog on %j of a refused Start",
    async (key) => {
      board({ mayStart: false });
      const denied = within(rowOf(1)).getByRole("button", {
        name: "Start a lane on issue #1",
      });

      denied.focus();
      await userEvent.keyboard(key);

      expect(document.activeElement).toBe(denied);
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  // #954
  it("does not shrink a refused Start on press, as the base button does", () => {
    board({ mayStart: false });

    const denied = within(rowOf(1)).getByRole("button", {
      name: "Start a lane on issue #1",
    });
    expect(denied.className).toContain("active:scale-100");
  });

  // #954
  it("asks again every idle interval while no lane runs, and every active interval while one does", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => ({ ok: true as const, data: LIST }));
    const idle = ticketList([ticket(1)]);
    const { unmount } = board({ initial: idle, api: { ...api, list } });

    await vi.advanceTimersByTimeAsync(ISSUES_POLL.idleMs - 1);
    expect(list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("p-1");
    unmount();

    const running = vi.fn(async () => ({
      ok: true as const,
      data: ticketList([ticket(2, { lane: RUNNING })]),
    }));
    board({
      initial: ticketList([ticket(2, { lane: RUNNING })]),
      api: { ...api, list: running },
    });
    await vi.advanceTimersByTimeAsync(ISSUES_POLL.activeMs - 1);
    expect(running).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(running).toHaveBeenCalledTimes(1);
  });
});
