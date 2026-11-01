// SPDX-License-Identifier: LicenseRef-Proprietary

// What one run of the sweep does when parts of it fail (#328): every step is tried, the ones that failed are named,
// and nothing a failure said reaches the log. The steps against a real database are in sweep.integration.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createCapabilitySet,
  type CapabilitySet,
} from "../capabilities/capability.ts";
import type { ExpiryReport } from "../db/repositories/runner-jobs-repository.ts";
import type { CleanupResult } from "../maintenance/cleanup.ts";
import type { RefreshOutcome } from "../models-dev/service.ts";
import {
  CHECKS_BUDGET_MS,
  MODELS_DEV_BUDGET_MS,
  SWEEP_STEPS,
  createDispatchSweep,
  type SweepSettings,
} from "./sweep.ts";

const expiry = {
  requeued: 0,
  leaseExpired: 0,
  timedOut: 0,
  noCapableRunner: 0,
};
const cleaned = {
  rateLimits: 0,
  unverifiedAccounts: 0,
  verificationTokens: 0,
  passwordResetTokens: 0,
  jobClaimedKeys: 0,
  jobDispatches: 0,
};

function setup(
  options: {
    settings?: SweepSettings;
    poll?: boolean;
    capabilities?: CapabilitySet;
  } = {},
) {
  const stored = new Map<string, string>();
  const mocks = {
    expireStaleJobs: vi.fn<() => Promise<ExpiryReport>>(async () => expiry),
    failUndispatched: vi.fn<(waitedMs: number) => Promise<number>>(
      async () => 0,
    ),
    countRunning: vi.fn<() => Promise<number>>(async () => 0),
    reviveStopped: vi.fn<(before: Date, at: Date) => Promise<number>>(
      async () => 0,
    ),
    sendDue: vi.fn<(limit?: number) => Promise<{ sent: number }>>(async () => ({
      sent: 0,
    })),
    get: vi.fn<(key: string) => Promise<string | undefined>>(async (key) =>
      stored.get(key),
    ),
    set: vi.fn<(key: string, value: string) => Promise<void>>(
      async (key, value) => {
        stored.set(key, value);
      },
    ),
    cleanup: vi.fn<() => Promise<CleanupResult>>(async () => cleaned),
    refreshIfDue: vi.fn<() => Promise<RefreshOutcome>>(async () => ({
      status: "skipped",
      reason: "not_due",
    })),
    retryDue: vi.fn<() => Promise<{ tried: number }>>(async () => ({
      tried: 0,
    })),
    reconcileDue: vi.fn<
      (options?: { budgetMs?: number }) => Promise<{ synced: number }>
    >(async () => ({
      synced: 0,
    })),
    releaseStranded: vi.fn<() => Promise<{ released: number }>>(async () => ({
      released: 0,
    })),
    deliverDue: vi.fn<() => Promise<{ delivered: number; failed: number }>>(
      async () => ({ delivered: 0, failed: 0 }),
    ),
    checkJournal: vi.fn<() => Promise<{ checked: number }>>(async () => ({
      checked: 0,
    })),
    retryWriteTokens: vi.fn<() => Promise<void>>(async () => undefined),
    info: vi.fn<(line: string) => void>(),
    error: vi.fn<(line: string) => void>(),
  };
  const sweep = createDispatchSweep({
    now: () => new Date("2026-10-15T12:30:00.000Z"),
    queue: {
      expireStaleJobs: mocks.expireStaleJobs,
      failUndispatched: mocks.failUndispatched,
      countRunning: mocks.countRunning,
    },
    dispatches: { reviveStopped: mocks.reviveStopped },
    ...(options.poll === true ? {} : { dispatch: { sendDue: mocks.sendDue } }),
    meta: { get: mocks.get, set: mocks.set },
    cleanup: mocks.cleanup,
    notices: { retryDue: mocks.retryDue },
    checks: { reconcileDue: mocks.reconcileDue },
    modelsDev: { refreshIfDue: mocks.refreshIfDue },
    billingHolds: { releaseStranded: mocks.releaseStranded },
    balanceMails: { deliverDue: mocks.deliverDue },
    journalCheck: { run: mocks.checkJournal },
    writeTokens: { retryPending: mocks.retryWriteTokens },
    settings: options.settings ?? { giveUpMs: 3_600_000, maxRunning: null },
    ...(options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
    log: { info: mocks.info, error: mocks.error },
  });
  return { sweep, ...mocks };
}

describe("the notices of refused reviews in a run of the sweep", () => {
  // #281-T06
  it("tries the notices that are due again and reports how many", async () => {
    const t = setup();
    t.retryDue.mockResolvedValueOnce({ tried: 3 });

    const report = await t.sweep.run();

    expect(t.retryDue).toHaveBeenCalledOnce();
    expect(report.noticesTried).toBe(3);
    expect(report.failedSteps).toEqual([]);
  });

  // #281-T06
  it("names a failed step and still does the others", async () => {
    const t = setup();
    t.retryDue.mockRejectedValueOnce(new Error("postgres://u:hunter2@db/app"));

    const report = await t.sweep.run();

    expect(report.failedSteps).toEqual(["notices"]);
    expect(t.cleanup).toHaveBeenCalledOnce();
    expect(JSON.stringify(t.error.mock.calls)).not.toContain("hunter2");
    expect(t.error).toHaveBeenCalledWith(
      "[sweep] SWEEP_STEP_FAILED step=notices",
    );
  });
});

describe("the check runs in a run of the sweep (#405)", () => {
  // #405-T06, #405-T32
  it("reconciles the check runs after the steps that end jobs, and reports how many it synced", async () => {
    const t = setup();
    const order: string[] = [];
    t.expireStaleJobs.mockImplementationOnce(async () => {
      order.push("expire");
      return expiry;
    });
    t.failUndispatched.mockImplementationOnce(async () => {
      order.push("give_up");
      return 0;
    });
    t.reconcileDue.mockImplementationOnce(async () => {
      order.push("checks");
      return { synced: 4 };
    });

    const report = await t.sweep.run();

    expect(order).toEqual(["expire", "give_up", "checks"]);
    expect(report.checksSynced).toBe(4);
    expect(report.failedSteps).toEqual([]);
  });

  // #405-T33
  it("reconciles in poll mode too: the check runs need no Dispatcher", async () => {
    const t = setup({ poll: true });

    await t.sweep.run();

    expect(t.reconcileDue).toHaveBeenCalledOnce();
  });

  // #405-T32 (review P2-4)
  it("gives the reconcile the time of an internal route, which lives longer than a request", async () => {
    const t = setup();

    await t.sweep.run();

    expect(t.reconcileDue).toHaveBeenCalledWith({ budgetMs: 40_000 });
  });

  // #405-T32
  it("names a failed reconcile and still does the cleanup, without what the failure said", async () => {
    const t = setup();
    t.reconcileDue.mockRejectedValueOnce(
      new Error("postgres://u:hunter2@db/app"),
    );

    const report = await t.sweep.run();

    expect(report.failedSteps).toEqual(["checks"]);
    expect(t.cleanup).toHaveBeenCalledOnce();
    expect(JSON.stringify(t.error.mock.calls)).not.toContain("hunter2");
    expect(t.error).toHaveBeenCalledWith(
      "[sweep] SWEEP_STEP_FAILED step=checks",
    );
  });

  it("works without a reconciler, as a sweep that was made before the check runs", async () => {
    const t = setup();
    const bare = createDispatchSweep({
      queue: {
        expireStaleJobs: t.expireStaleJobs,
        failUndispatched: t.failUndispatched,
        countRunning: t.countRunning,
      },
      dispatches: { reviveStopped: t.reviveStopped },
      meta: { get: t.get, set: t.set },
      cleanup: t.cleanup,
      settings: { giveUpMs: null, maxRunning: null },
      log: { info: t.info, error: t.error },
    });

    expect((await bare.run()).checksSynced).toBe(0);
  });
});

describe("the holds of ended jobs in a run of the sweep (#591)", () => {
  // #591-T14
  it("releases the stranded holds after the cleanup and before the models.dev fetch, and reports how many", async () => {
    const t = setup();
    const order: string[] = [];
    t.cleanup.mockImplementationOnce(async () => {
      order.push("cleanup");
      return cleaned;
    });
    t.releaseStranded.mockImplementationOnce(async () => {
      order.push("billing_holds");
      return { released: 2 };
    });
    t.refreshIfDue.mockImplementationOnce(async () => {
      order.push("models_dev");
      return { status: "skipped", reason: "not_due" };
    });

    const report = await t.sweep.run();

    expect(order).toEqual(["cleanup", "billing_holds", "models_dev"]);
    expect(report.holdsReleased).toBe(2);
    expect(report.failedSteps).toEqual([]);
  });

  // #591-T15
  it("names a failed step without what the database said, and still does the others", async () => {
    const t = setup();
    t.releaseStranded.mockRejectedValueOnce(
      new Error("postgres://u:hunter2@db/app"),
    );

    const report = await t.sweep.run();

    expect(report.failedSteps).toEqual(["billing_holds"]);
    expect(report.holdsReleased).toBe(0);
    expect(t.refreshIfDue).toHaveBeenCalledOnce();
    expect(JSON.stringify(t.error.mock.calls)).not.toContain("hunter2");
    expect(t.error).toHaveBeenCalledWith(
      "[sweep] SWEEP_STEP_FAILED step=billing_holds",
    );
  });
});

describe("the balance mails in a run of the sweep (#506)", () => {
  // #506-T16
  it("delivers the due balance mails after the release of the holds and before the models.dev fetch, and reports how many were sent", async () => {
    const t = setup();
    const order: string[] = [];
    t.releaseStranded.mockImplementationOnce(async () => {
      order.push("billing_holds");
      return { released: 1 };
    });
    t.deliverDue.mockImplementationOnce(async () => {
      order.push("balance_mails");
      return { delivered: 2, failed: 1 };
    });
    t.refreshIfDue.mockImplementationOnce(async () => {
      order.push("models_dev");
      return { status: "skipped", reason: "not_due" };
    });

    const report = await t.sweep.run();

    expect(order).toEqual(["billing_holds", "balance_mails", "models_dev"]);
    expect(report.balanceMailsSent).toBe(2);
    expect(report.failedSteps).toEqual([]);
  });

  // #506-T16
  it("names a failed step without what it said, and still does the others", async () => {
    const t = setup();
    t.deliverDue.mockRejectedValueOnce(
      new Error("postgres://u:hunter2@db/app"),
    );

    const report = await t.sweep.run();

    expect(report.failedSteps).toEqual(["balance_mails"]);
    expect(report.balanceMailsSent).toBe(0);
    expect(t.refreshIfDue).toHaveBeenCalledOnce();
    expect(JSON.stringify(t.error.mock.calls)).not.toContain("hunter2");
    expect(t.error).toHaveBeenCalledWith(
      "[sweep] SWEEP_STEP_FAILED step=balance_mails",
    );
  });
});

describe("the check of the journal in a run of the sweep (#626)", () => {
  // #626-T15
  it("checks the journal after the balance mails and before the models.dev fetch, and reports how many workspaces it checked", async () => {
    const t = setup();
    const order: string[] = [];
    t.releaseStranded.mockImplementationOnce(async () => {
      order.push("billing_holds");
      return { released: 0 };
    });
    t.deliverDue.mockImplementationOnce(async () => {
      order.push("balance_mails");
      return { delivered: 0, failed: 0 };
    });
    t.checkJournal.mockImplementationOnce(async () => {
      order.push("journal_check");
      return { checked: 7 };
    });
    t.refreshIfDue.mockImplementationOnce(async () => {
      order.push("models_dev");
      return { status: "skipped", reason: "not_due" };
    });

    const report = await t.sweep.run();

    expect(order).toEqual([
      "billing_holds",
      "balance_mails",
      "journal_check",
      "models_dev",
    ]);
    expect(report.journalChecked).toBe(7);
    expect(report.failedSteps).toEqual([]);
  });

  // #626-T15
  it("names a failed step without what it said, and still does the others", async () => {
    const t = setup();
    t.checkJournal.mockRejectedValueOnce(
      new Error("postgres://u:hunter2@db/app"),
    );

    const report = await t.sweep.run();

    expect(report.failedSteps).toEqual(["journal_check"]);
    expect(report.journalChecked).toBe(0);
    expect(t.refreshIfDue).toHaveBeenCalledOnce();
    expect(JSON.stringify(t.error.mock.calls)).not.toContain("hunter2");
    expect(t.error).toHaveBeenCalledWith(
      "[sweep] SWEEP_STEP_FAILED step=journal_check",
    );
  });

  // #626-T15
  it("is a step of the list, between the balance mails and the models.dev fetch", () => {
    expect(SWEEP_STEPS.slice(-3)).toEqual([
      "balance_mails",
      "journal_check",
      "models_dev",
    ]);
  });
});

describe("the daily models.dev fetch in a run of the sweep (#548)", () => {
  // #548-T03
  it("asks the fetch whether it is due, after the steps that move jobs, and reports what it did", async () => {
    const t = setup();
    const order: string[] = [];
    t.reconcileDue.mockImplementationOnce(async () => {
      order.push("checks");
      return { synced: 0 };
    });
    t.refreshIfDue.mockImplementationOnce(async () => {
      order.push("models_dev");
      return { status: "applied", summary: { models: 3 } };
    });
    t.cleanup.mockImplementationOnce(async () => {
      order.push("cleanup");
      return cleaned;
    });

    const report = await t.sweep.run();

    expect(order).toEqual(["checks", "cleanup", "models_dev"]);
    expect(report.modelsDev).toBe("applied");
    expect(report.failedSteps).toEqual([]);
  });

  // #548-T04
  it("gives the fetch one deadline that leaves the function limit of the route room for the other steps", async () => {
    const t = setup();

    await t.sweep.run();

    expect(t.refreshIfDue).toHaveBeenCalledWith({
      deadlineMs: MODELS_DEV_BUDGET_MS,
    });
    const config = JSON.parse(
      readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"),
    ) as { functions: Record<string, { maxDuration: number }> };
    const limitMs =
      (config.functions["src/app/api/internal/**/route.ts"]?.maxDuration ?? 0) *
      1000;
    expect(limitMs).toBe(300_000);
    // The fetch and the check runs, which both have a budget, together take at most half of the limit; the steps
    // before them (single queries and calls with time limits of their own) have the rest.
    expect(MODELS_DEV_BUDGET_MS + CHECKS_BUDGET_MS).toBeLessThanOrEqual(
      limitMs / 2,
    );
  });

  // #548-T04
  it("does not count a fetch that failed as a failed sweep: the fetch records its own failure", async () => {
    const t = setup();
    t.refreshIfDue.mockResolvedValueOnce({
      status: "failed",
      code: "models_dev_http_status",
    });

    const report = await t.sweep.run();

    expect(report.modelsDev).toBe("failed");
    expect(report.failedSteps).toEqual([]);
  });

  // #548-T13
  it("reports a fetch that is switched off or not due as skipped", async () => {
    const t = setup();

    expect((await t.sweep.run()).modelsDev).toBe("skipped");
  });

  // #548-T04
  it("names a fetch that threw, without what it said, and has done the other steps before", async () => {
    const t = setup();
    t.refreshIfDue.mockRejectedValueOnce(
      new Error("postgres://u:hunter2@db/app"),
    );

    const report = await t.sweep.run();

    expect(report.failedSteps).toEqual(["models_dev"]);
    expect(t.cleanup).toHaveBeenCalledOnce();
    expect(JSON.stringify(t.error.mock.calls)).not.toContain("hunter2");
  });

  it("works without a fetch, as a sweep that was made before the catalog", async () => {
    const t = setup();
    const bare = createDispatchSweep({
      queue: {
        expireStaleJobs: t.expireStaleJobs,
        failUndispatched: t.failUndispatched,
        countRunning: t.countRunning,
      },
      dispatches: { reviveStopped: t.reviveStopped },
      meta: { get: t.get, set: t.set },
      cleanup: t.cleanup,
      settings: { giveUpMs: null, maxRunning: null },
      log: { info: t.info, error: t.error },
    });

    expect((await bare.run()).modelsDev).toBeNull();
  });
});

describe("a run of the sweep that partly fails", () => {
  // #328-T01
  it("still gives up, sends and cleans up when the expiry fails, and names the failed step only", async () => {
    const t = setup();
    t.expireStaleJobs.mockRejectedValueOnce(
      new Error("postgres://user:hunter2@db.example/app"),
    );

    const report = await t.sweep.run();

    expect(report.failedSteps).toEqual(["expire"]);
    expect(t.failUndispatched).toHaveBeenCalledWith(3_600_000);
    expect(t.sendDue).toHaveBeenCalledOnce();
    expect(t.cleanup).toHaveBeenCalledOnce();
    expect(JSON.stringify(t.error.mock.calls)).not.toContain("hunter2");
    expect(t.error).toHaveBeenCalledWith(
      "[sweep] SWEEP_STEP_FAILED step=expire",
    );
  });

  // #328-T04
  it("does not give up when the setting is off, and still sends", async () => {
    const t = setup({ settings: { giveUpMs: null, maxRunning: null } });

    await t.sweep.run();

    expect(t.failUndispatched).not.toHaveBeenCalled();
    expect(t.sendDue).toHaveBeenCalledOnce();
  });

  // #328-T08
  it.each([
    ["nothing at the cap", 3, 3, undefined],
    ["nothing over the cap", 3, 5, undefined],
    ["the difference below it", 3, 1, 2],
    ["never more than the default batch", 1000, 0, 20],
  ])("keeps to the free slots: %s", async (_, cap, running, expected) => {
    const t = setup({ settings: { giveUpMs: null, maxRunning: cap } });
    t.countRunning.mockResolvedValue(running);

    await t.sweep.run();

    if (expected === undefined) expect(t.sendDue).not.toHaveBeenCalled();
    else expect(t.sendDue).toHaveBeenCalledWith(expected);
  });

  // #328-T09
  it("does not revive, count or send in poll mode", async () => {
    const t = setup({
      poll: true,
      settings: { giveUpMs: null, maxRunning: 3 },
    });

    await t.sweep.run();

    expect(t.reviveStopped).not.toHaveBeenCalled();
    expect(t.sendDue).not.toHaveBeenCalled();
    expect(t.countRunning).not.toHaveBeenCalled();
  });

  // #328-T11
  it("treats an hour it cannot read as never cleaned and cleans again", async () => {
    const t = setup();
    t.get.mockResolvedValue("not a number");

    const report = await t.sweep.run();

    expect(report.cleanedUp).toBe(true);
    expect(t.set).toHaveBeenCalledWith(
      "maintenance.sweep_cleanup_hour",
      String(Math.floor(Date.parse("2026-10-15T12:30:00.000Z") / 3_600_000)),
    );
  });

  // #328-T11
  it("does not clean up twice in an hour", async () => {
    const t = setup();

    await t.sweep.run();
    const second = await t.sweep.run();

    expect(t.cleanup).toHaveBeenCalledOnce();
    expect(second.cleanedUp).toBe(false);
  });
});

describe("a run of the sweep of a deployment with a capability set (#731)", () => {
  // #731-T03
  it("runs no step of billing without the billing capability, and every other step", async () => {
    const m = setup({
      capabilities: createCapabilitySet(["review", "dynamic-review"]),
    });

    const report = await m.sweep.run();

    expect(m.releaseStranded).not.toHaveBeenCalled();
    expect(m.deliverDue).not.toHaveBeenCalled();
    expect(m.checkJournal).not.toHaveBeenCalled();
    for (const ran of [
      m.expireStaleJobs,
      m.failUndispatched,
      m.reviveStopped,
      m.sendDue,
      m.retryDue,
      m.reconcileDue,
      m.cleanup,
      m.refreshIfDue,
    ])
      expect(ran).toHaveBeenCalled();
    expect(report.failedSteps).toEqual([]);
  });

  // #731-T04
  it("moves no job without the review capability, and still cleans up and fetches the catalog", async () => {
    const m = setup({ capabilities: createCapabilitySet([]) });

    await m.sweep.run();

    for (const idle of [
      m.expireStaleJobs,
      m.failUndispatched,
      m.reviveStopped,
      m.sendDue,
      m.retryDue,
      m.reconcileDue,
      m.releaseStranded,
      m.deliverDue,
      m.checkJournal,
    ])
      expect(idle).not.toHaveBeenCalled();
    expect(m.cleanup).toHaveBeenCalled();
    expect(m.refreshIfDue).toHaveBeenCalled();
  });

  // #731-T01
  it("runs every step with the whole set, and when no set is given", async () => {
    for (const capabilities of [
      createCapabilitySet(["review", "dynamic-review", "billing"]),
      undefined,
    ]) {
      const m = setup(capabilities === undefined ? {} : { capabilities });

      await m.sweep.run();

      for (const ran of [
        m.expireStaleJobs,
        m.sendDue,
        m.reconcileDue,
        m.releaseStranded,
        m.deliverDue,
        m.checkJournal,
        m.refreshIfDue,
      ])
        expect(ran).toHaveBeenCalled();
    }
  });
});

describe("the write tokens of the Implementer in a run of the sweep (#790)", () => {
  // #790
  it("tries again for the tokens of ended turns that could not be switched off, in a deployment with the Implementer", async () => {
    const t = setup({
      capabilities: createCapabilitySet([
        "review",
        "dynamic-review",
        "implementer",
      ]),
    });

    const report = await t.sweep.run();

    expect(t.retryWriteTokens).toHaveBeenCalledOnce();
    expect(report.failedSteps).toEqual([]);
  });

  // #790
  it("does not try in a deployment without the capability: code-review.com has no such token", async () => {
    const t = setup({
      capabilities: createCapabilitySet(["review", "dynamic-review"]),
    });

    await t.sweep.run();

    expect(t.retryWriteTokens).not.toHaveBeenCalled();
  });

  // #790
  it("goes on with the other steps, and says which step failed, when the retry fails", async () => {
    const t = setup({
      capabilities: createCapabilitySet([
        "review",
        "dynamic-review",
        "implementer",
      ]),
    });
    t.retryWriteTokens.mockRejectedValueOnce(new Error("down"));

    const report = await t.sweep.run();

    expect(report.failedSteps).toEqual(["write_tokens"]);
    expect(t.cleanup).toHaveBeenCalledOnce();
  });
});
