// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: the loop of the reconciler of the workflow runs: its time budget and a failure to ask which runs are due.
import { describe, expect, it, vi } from "vitest";
import { reconcileRuns } from "./reconcile.ts";

const runs = ["a", "b", "c", "d"].map((runId) => ({
  workspaceId: "w-1",
  runId,
}));

describe("the reconciler of the workflow runs", () => {
  // #844-T274
  it("looks at every due run when no budget is set", async () => {
    const look = vi.fn(async () => undefined);

    expect(await reconcileRuns({ due: async () => runs, look })).toEqual({
      looked: 4,
      failed: 0,
    });
    expect(look).toHaveBeenCalledTimes(4);
  });

  // #844-T275
  it("stops looking at further runs once its time is used up, and leaves the rest for the next pass", async () => {
    let at = 0;
    const looked: string[] = [];

    const report = await reconcileRuns({
      due: async () => runs,
      look: async ({ runId }) => {
        looked.push(runId);
        at += 400;
      },
      budgetMs: 1000,
      clock: () => at,
    });

    // 0, 400 and 800 are inside the budget; at 1200 it is spent.
    expect(looked).toEqual(["a", "b", "c"]);
    expect(report).toEqual({ looked: 3, failed: 0 });
  });

  // #844-T276
  it("counts a run it could not advance and goes on with the others", async () => {
    const report = await reconcileRuns({
      due: async () => runs,
      look: async ({ runId }) => {
        if (runId === "b") throw new Error("postgres://user:secret@host/db");
      },
    });

    expect(report).toEqual({ looked: 4, failed: 1 });
  });

  // #844-T277
  it("answers a failed pass, not a throw, when it cannot ask which runs are due", async () => {
    const look = vi.fn(async () => undefined);

    const report = await reconcileRuns({
      due: async () => {
        throw new Error("the database is down");
      },
      look,
    });

    expect(report).toEqual({ looked: 0, failed: 1 });
    expect(look).not.toHaveBeenCalled();
  });
});
