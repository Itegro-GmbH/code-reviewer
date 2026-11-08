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

function renderControls(showResync: boolean) {
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
  render(
    <TicketSourceControls
      workspaceSlug="acme"
      projectId="p-1"
      repositoryId="repo-1"
      board={null}
      canChange
      showResync={showResync}
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
  });
});
