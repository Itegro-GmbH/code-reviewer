// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down "Resync" on the Setup tab (#937): it asks again while the route answers 202, shows how far it is, ends with a sentence for
// what was read, a failure or the limit of calls, and shows the hint that the tickets may be out of date.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  prompted = false,
) {
  return render(
    <ResyncTickets
      workspaceSlug="acme"
      repositoryId="repo-1"
      staleness={staleness}
      prompted={prompted}
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
    expect(resync).toHaveBeenCalledWith("repo-1", expect.any(AbortSignal));
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
    expect(screen.getByText(/100 tickets were read and are kept/)).toBeTruthy();
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
    expect(
      screen.getByText(
        `${String(RESYNC_MAX_CALLS)} tickets were read and are kept.`,
      ),
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

describe("Resync, leaving the page and pressing twice", () => {
  // #937-T46
  it("stops asking, aborts the call under way and touches nothing when the page is left in the middle of the loop", async () => {
    const user = userEvent.setup();
    const signals: AbortSignal[] = [];
    const resync = vi.fn<SetupApi["resync"]>((_id, signal) => {
      if (signal !== undefined) signals.push(signal);
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () =>
          resolve({
            ok: false,
            status: null,
            code: "NETWORK_ERROR",
            issues: [],
          }),
        );
      });
    });
    const view = renderResync(resync);

    await user.click(screen.getByRole("button", { name: "Resync" }));
    await screen.findByRole("button", { name: /call 1/ });
    view.unmount();
    await Promise.resolve();
    await Promise.resolve();

    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(navigation.refresh).not.toHaveBeenCalled();
  });

  // #937-T47
  it("does not start a second loop on a second click before the first has rendered as busy", async () => {
    const resync = vi.fn<SetupApi["resync"]>(() => new Promise(() => {}));
    renderResync(resync);
    const button = screen.getByRole("button", { name: "Resync" });

    // Two clicks in one task: the state of the first has not been rendered yet.
    act(() => {
      button.click();
      button.click();
    });

    expect(resync).toHaveBeenCalledTimes(1);
  });

  // #937-T48
  it("can be pressed again after it ended", async () => {
    const user = userEvent.setup();
    const resync = vi.fn<SetupApi["resync"]>().mockResolvedValue(progress());
    renderResync(resync);

    await user.click(screen.getByRole("button", { name: "Resync" }));
    await screen.findByText(/Done: 0 tickets read/);
    await user.click(screen.getByRole("button", { name: "Resync" }));

    await waitFor(() => expect(resync).toHaveBeenCalledTimes(2));
  });
});

describe("Resync after the board changed", () => {
  // #937-T49
  it("says the tickets still have the old board's statuses and stands out until a Resync has finished", async () => {
    const user = userEvent.setup();
    renderResync(
      vi.fn<SetupApi["resync"]>().mockResolvedValue(progress()),
      null,
      true,
    );

    expect(screen.getByRole("note").textContent).toContain(
      "press Resync to read the new board",
    );
    await user.click(screen.getByRole("button", { name: "Resync" }));

    await screen.findByText(/Done: 0 tickets read/);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
