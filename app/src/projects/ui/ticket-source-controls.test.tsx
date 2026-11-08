// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the picker and Resync of the Setup tab as one piece (#937): saving a board puts "Resync" forward, a Member who may not resync
// gets the picker's message alone.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));
const api = vi.hoisted(() => ({
  setup: {
    boards: vi.fn(),
    setBoard: vi.fn(),
    resync: vi.fn(),
  },
}));
vi.mock("./setup-api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup-api.ts")>()),
  browserSetupApi: () => api.setup,
}));

import { TicketSourceControls } from "./ticket-source-controls.tsx";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderControls(showResync: boolean, switchedOn = true) {
  api.setup.boards.mockResolvedValue({
    ok: true,
    data: {
      available: true,
      boards: [
        {
          projectV2Id: "PVT_1",
          number: 1,
          title: "Roadmap",
          hasStatusField: true,
          statuses: ["Todo"],
        },
      ],
    },
  });
  api.setup.setBoard.mockResolvedValue({
    ok: true,
    data: { project: { id: "p-1" } },
  });
  api.setup.resync.mockResolvedValue({
    ok: true,
    data: {
      status: "done",
      written: 0,
      removed: 0,
      skipped: 0,
      boardAvailable: true,
    },
  });
  render(
    <TicketSourceControls
      workspaceSlug="acme"
      projectId="p-1"
      repositoryId="repo-1"
      board={null}
      canChange
      showResync={showResync}
      switchedOn={switchedOn}
      staleness={null}
    />,
  );
}

describe("the ticket source controls", () => {
  // #937-T61
  it("puts Resync forward after a board was saved, next to the message that says why", async () => {
    const user = userEvent.setup();
    renderControls(true);
    expect(screen.queryByRole("note")).toBeNull();
    const select = (await screen.findByLabelText(
      "Board (optional)",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));

    await user.selectOptions(select, "PVT_1");

    expect((await screen.findByRole("note")).textContent).toContain(
      "press Resync to read the new board",
    );
    expect(screen.getByRole("button", { name: "Resync" })).toBeTruthy();
  });

  // #937-T62
  it("shows no Resync to a person who may not resync, and still says what the save left behind", async () => {
    const user = userEvent.setup();
    renderControls(false);
    const select = (await screen.findByLabelText(
      "Board (optional)",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));

    await user.selectOptions(select, "PVT_1");

    expect(await screen.findByText(/Board saved/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resync" })).toBeNull();
    // no button to press, so the message does not say to press one
    expect(screen.queryByText(/press Resync to read the new board/)).toBeNull();
    expect(
      screen.getByText(/a person who may change the project settings/),
    ).toBeTruthy();
  });

  // #947-T05
  it("says the project is switched off, not to press a Resync that is not there, when a board is saved on a switched-off project", async () => {
    const user = userEvent.setup();
    renderControls(false, false);
    const select = (await screen.findByLabelText(
      "Board (optional)",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));

    await user.selectOptions(select, "PVT_1");

    expect(
      await screen.findByText(
        /The project is switched off, so its tickets are not read/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resync" })).toBeNull();
  });

  // #947-T06
  it("puts Resync forward again when the board is changed a second time after a Resync has finished", async () => {
    const user = userEvent.setup();
    renderControls(true);
    const select = (await screen.findByLabelText(
      "Board (optional)",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await user.selectOptions(select, "PVT_1");
    await screen.findByRole("note");
    await user.click(screen.getByRole("button", { name: "Resync" }));
    await screen.findByText(/Done: 0 tickets read/);
    expect(screen.queryByRole("note")).toBeNull();

    await user.selectOptions(select, "");

    expect((await screen.findByRole("note")).textContent).toContain(
      "press Resync to read the new board",
    );
  });
});
