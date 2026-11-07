// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the board picker of the Setup tab (#937): it lists the boards of the repository with "None", saves a choice at once, says what
// went wrong and goes back, cannot choose a board without a Status field, and is read-only for a person who may not manage projects.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

import type { BoardsAnswer } from "./api.ts";
import type { SetupApi } from "./setup-api.ts";
import { TicketBoardPicker } from "./ticket-board-picker.tsx";

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
});

const BOARDS: BoardsAnswer = {
  available: true,
  boards: [
    {
      projectV2Id: "PVT_1",
      number: 1,
      title: "Roadmap",
      hasStatusField: true,
      statuses: ["Todo", "Done"],
    },
    {
      projectV2Id: "PVT_2",
      number: 2,
      title: "Loose",
      hasStatusField: false,
      statuses: [],
    },
  ],
};

function renderPicker(
  options: {
    boards?: Awaited<ReturnType<SetupApi["boards"]>>;
    setBoard?: SetupApi["setBoard"];
    board?: string | null;
    canChange?: boolean;
  } = {},
) {
  const boards = vi.fn<SetupApi["boards"]>(
    async () => options.boards ?? { ok: true, data: BOARDS },
  );
  const setBoard = vi.fn<SetupApi["setBoard"]>(
    options.setBoard ??
      (async () => ({ ok: true, data: { project: { id: "p-1" } } })),
  );
  render(
    <TicketBoardPicker
      workspaceSlug="acme"
      projectId="p-1"
      repositoryId="repo-1"
      board={options.board ?? null}
      canChange={options.canChange ?? true}
      api={{ boards, setBoard, resync: vi.fn() }}
    />,
  );
  return { boards, setBoard };
}

describe("the board picker", () => {
  // #937-T50
  it("lists none and the boards of the repository, with the one without a Status field out of reach", async () => {
    renderPicker({ board: "PVT_1" });

    const select = (await screen.findByLabelText(
      "Board (optional)",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));

    expect(select.value).toBe("PVT_1");
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "None",
      "#1 Roadmap",
      "#2 Loose (no Status field)",
    ]);
    expect(select.options[2]!.disabled).toBe(true);
  });

  // #937-T51
  it("saves a chosen board at once, says so and refreshes the page", async () => {
    const user = userEvent.setup();
    const { setBoard } = renderPicker();
    const select = await screen.findByLabelText("Board (optional)");
    await waitFor(() =>
      expect((select as HTMLSelectElement).disabled).toBe(false),
    );

    await user.selectOptions(select, "PVT_1");

    expect(setBoard).toHaveBeenCalledWith("p-1", "PVT_1");
    expect(await screen.findByText(/Board saved/)).toBeTruthy();
    expect((select as HTMLSelectElement).value).toBe("PVT_1");
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  // #937-T52
  it("clears the board with None", async () => {
    const user = userEvent.setup();
    const { setBoard } = renderPicker({ board: "PVT_1" });
    const select = await screen.findByLabelText("Board (optional)");
    await waitFor(() =>
      expect((select as HTMLSelectElement).disabled).toBe(false),
    );

    await user.selectOptions(select, "");

    expect(setBoard).toHaveBeenCalledWith("p-1", null);
    expect(await screen.findByText("Board removed.")).toBeTruthy();
  });

  // #937-T53
  it("keeps the choice where it was and says why when the save is refused", async () => {
    const user = userEvent.setup();
    renderPicker({
      board: "PVT_1",
      setBoard: async () => ({
        ok: false,
        status: 503,
        code: "PROJECT_BOARDS_UNAVAILABLE",
        issues: [],
      }),
    });
    const select = (await screen.findByLabelText(
      "Board (optional)",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));

    await user.selectOptions(select, "");

    expect(
      await screen.findByText(/could not be asked for the boards/),
    ).toBeTruthy();
    expect(select.value).toBe("PVT_1");
    expect(navigation.refresh).not.toHaveBeenCalled();
  });

  // #937-T54
  it("says when the boards cannot be read or listed, and still shows the board that is set", async () => {
    renderPicker({
      board: "PVT_9",
      boards: { ok: true, data: { available: false, boards: [] } },
    });

    expect(
      await screen.findByText(/did not let the App read the boards/),
    ).toBeTruthy();
    const select = screen.getByLabelText(
      "Board (optional)",
    ) as HTMLSelectElement;
    expect(select.value).toBe("PVT_9");
    expect(select.options[1]!.textContent).toContain("cannot be read now");
    cleanup();

    renderPicker({
      boards: {
        ok: false,
        status: 503,
        code: "PROJECT_BOARDS_UNAVAILABLE",
        issues: [],
      },
    });
    expect(
      await screen.findByText(/could not be asked for the boards right now/),
    ).toBeTruthy();
  });

  // #937-T55
  it("asks GitHub for nothing and offers no choice to a person who may not manage projects", () => {
    const { boards } = renderPicker({ canChange: false, board: "PVT_1" });

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText(/A board is set on this project/)).toBeTruthy();
    expect(boards).not.toHaveBeenCalled();
  });
});
