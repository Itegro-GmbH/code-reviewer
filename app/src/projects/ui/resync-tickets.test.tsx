// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down "Resync" on the Setup tab (#937): it asks again while the route answers 202, shows how far it is, ends with a sentence for
// what was read, a failure or the limit of calls, and shows the hint that the tickets may be out of date.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

import type { SetupApi, ResyncProgress } from "./setup-api.ts";
import { RESYNC_MAX_CALLS, ResyncTickets } from "./resync-tickets.tsx";

afterEach(() => {
  cleanup();
  navigation.refresh.mockClear();
});

const progress = (overrides: Partial<ResyncProgress> = {}) => ({
  ok: true as const,
  data: {
    status: "done" as const,
    written: 0,
    removed: 0,
    skipped: 0,
    boardAvailable: true,
    ...overrides,
  },
});

function renderResync(
  resync: SetupApi["resync"],
  staleness: Parameters<typeof ResyncTickets>[0]["staleness"] = null,
) {
  render(
    <ResyncTickets
      workspaceSlug="acme"
      repositoryId="repo-1"
      staleness={staleness}
      api={{ boards: vi.fn(), setBoard: vi.fn(), resync }}
    />,
  );
}

describe("Resync", () => {
  // #937-T40
  it("asks again while the route answers partial, until it is done, and says what was read", async () => {
    const user = userEvent.setup();
    const resync = vi
      .fn<SetupApi["resync"]>()
      .mockResolvedValueOnce(progress({ status: "partial", written: 100 }))
      .mockResolvedValueOnce(progress({ status: "partial", written: 40 }))
      .mockResolvedValueOnce(progress({ written: 7, removed: 2 }));
    renderResync(resync);

    await user.click(screen.getByRole("button", { name: "Resync" }));

    expect(
      await screen.findByText("Done: 147 tickets read, 2 removed."),
    ).toBeTruthy();
    expect(resync).toHaveBeenCalledTimes(3);
    expect(resync).toHaveBeenCalledWith("repo-1");
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  // #937-T41
  it("shows the call it is on and cannot be pressed twice while it reads", async () => {
    const user = userEvent.setup();
    let release: (
      value: Awaited<ReturnType<SetupApi["resync"]>>,
    ) => void = () => {};
    const resync = vi.fn<SetupApi["resync"]>(
      () => new Promise((resolve) => (release = resolve)),
    );
    renderResync(resync);

    await user.click(screen.getByRole("button", { name: "Resync" }));

    const busy = await screen.findByRole("button", {
      name: "Reading from GitHub… (call 1)",
    });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    release(progress());
    expect(await screen.findByRole("button", { name: "Resync" })).toBeTruthy();
    expect(resync).toHaveBeenCalledTimes(1);
  });

  // #937-T42
  it("stops at an error with its sentence and keeps what was read for the next press", async () => {
    const user = userEvent.setup();
    const resync = vi
      .fn<SetupApi["resync"]>()
      .mockResolvedValueOnce(progress({ status: "partial", written: 100 }))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        code: "TRACKER_SYNC_FAILED",
        issues: [],
      });
    renderResync(resync);

    await user.click(screen.getByRole("button", { name: "Resync" }));

    expect(
      await screen.findByText(/GitHub could not be read just now/),
    ).toBeTruthy();
    expect(resync).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Resync" })).toBeTruthy();
  });

  // #937-T43
  it("gives up after the most calls it makes and says to press again", async () => {
    const user = userEvent.setup();
    const resync = vi
      .fn<SetupApi["resync"]>()
      .mockResolvedValue(progress({ status: "partial", written: 1 }));
    renderResync(resync);

    await user.click(screen.getByRole("button", { name: "Resync" }));

    expect(
      await screen.findByText(/Still reading after many calls/),
    ).toBeTruthy();
    expect(resync).toHaveBeenCalledTimes(RESYNC_MAX_CALLS);
  });

  // #937-T44
  it("says when tickets were skipped or the App cannot read boards", async () => {
    const user = userEvent.setup();
    renderResync(
      vi
        .fn<SetupApi["resync"]>()
        .mockResolvedValue(progress({ skipped: 2, boardAvailable: false })),
    );

    await user.click(screen.getByRole("button", { name: "Resync" }));

    expect(await screen.findByText(/2 tickets could not be read/)).toBeTruthy();
    expect(
      screen.getByText(/did not let the App read the boards/),
    ).toBeTruthy();
  });

  // #937-T45
  it("shows the hint for a stale sync and for tickets never read, and none otherwise", () => {
    renderResync(vi.fn(), { kind: "stale", days: 5 });
    expect(screen.getByRole("note").textContent).toContain("5 days ago");
    cleanup();

    renderResync(vi.fn(), { kind: "never" });
    expect(screen.getByRole("note").textContent).toContain(
      "not been read in full",
    );
    cleanup();

    renderResync(vi.fn(), null);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
