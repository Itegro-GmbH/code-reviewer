// SPDX-License-Identifier: LicenseRef-Proprietary

// The hook at the end of a turn (`turnEnded` of `ReportDeps`, wired in `shared.ts`) has two independent reactions: the workflow engine
// goes on with the run whose step the turn was (#844), and the instruction a person queued behind the turn starts (#841). Neither waits
// for the other and neither can fail the other.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  startQueuedFollowUps: vi.fn<() => Promise<void>>(),
  database: vi.fn<() => unknown>(),
  scheduled: [] as Array<Promise<void>>,
}));

vi.mock("../implementer/follow-up-shared.ts", () => ({
  startQueuedFollowUps: hoisted.startQueuedFollowUps,
}));
vi.mock("../db/startup.ts", () => ({ getDatabase: hoisted.database }));
// As the real one: the work runs, and what it throws or rejects with goes nowhere.
vi.mock("../dispatch/shared.ts", () => ({
  runAfterResponse: (work: () => Promise<void>) => {
    hoisted.scheduled.push(
      Promise.resolve()
        .then(work)
        .catch(() => undefined),
    );
  },
}));

import { turnEnded } from "./shared.ts";

beforeEach(() => {
  hoisted.startQueuedFollowUps.mockReset().mockResolvedValue(undefined);
  hoisted.database.mockReset();
  hoisted.scheduled.length = 0;
});

describe("the hook at the end of a turn", () => {
  // #841-W01
  it("starts the queued instruction although the workflow engine cannot be reached", async () => {
    // The engine needs the database; without one it throws, and the hook must still hand the end to the starter.
    hoisted.database.mockImplementation(() => {
      throw new Error("the database is down");
    });

    turnEnded({ id: "job-1", workspaceId: "w-1" });
    await Promise.all(hoisted.scheduled);

    expect(hoisted.startQueuedFollowUps).toHaveBeenCalledOnce();
  });

  // #841-W02
  it("does not throw or reject when the starter fails, and the engine's reaction is still scheduled", async () => {
    hoisted.database.mockImplementation(() => {
      throw new Error("the database is down");
    });
    hoisted.startQueuedFollowUps.mockRejectedValue(new Error("down"));

    expect(() => turnEnded({ id: "job-1", workspaceId: "w-1" })).not.toThrow();
    await expect(Promise.all(hoisted.scheduled)).resolves.toBeDefined();

    // One reaction for the engine, one for the starter.
    expect(hoisted.scheduled).toHaveLength(2);
  });
});
