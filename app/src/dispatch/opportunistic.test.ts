// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import {
  createOpportunisticMaintenance,
  OPPORTUNISTIC_INTERVAL_MS,
  OPPORTUNISTIC_MIN_JOB_AGE_MS,
} from "./opportunistic.ts";

function setup(
  options: { held?: boolean; failWith?: Error; checks?: boolean } = {},
) {
  let time = 1_000_000;
  const queue = {
    expireStaleJobs: vi.fn(() => {
      if (options.failWith) return Promise.reject(options.failWith);
      return Promise.resolve({
        requeued: 1,
        leaseExpired: 0,
        timedOut: 0,
        noCapableRunner: 0,
      });
    }),
  };
  const dispatch = { sendDue: vi.fn(() => Promise.resolve({ sent: 1 })) };
  const log = { error: vi.fn() };
  const checks = {
    reconcileDue: vi.fn<
      (options?: { budgetMs?: number }) => Promise<{ synced: number }>
    >(() => Promise.resolve({ synced: 0 })),
  };
  const maintenance = createOpportunisticMaintenance({
    withLock: async (work) =>
      options.held === true
        ? { acquired: false }
        : { acquired: true, value: await work() },
    queue,
    dispatch,
    ...(options.checks === false ? {} : { checks }),
    now: () => time,
    log,
  });
  return {
    maintenance,
    queue,
    dispatch,
    checks,
    log,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("the repair work of the requests that touch the database", () => {
  // #395-T11
  it("releases the leases that ran out and sends what is due", async () => {
    const t = setup();

    expect(await t.maintenance.run()).toBe("ran");

    expect(t.queue.expireStaleJobs).toHaveBeenCalledOnce();
    expect(t.dispatch.sendDue).toHaveBeenCalledOnce();
  });

  // #405-T06, #405-T32
  it("reconciles the check runs after the leases were released, in the same run", async () => {
    const t = setup();

    await t.maintenance.run();

    expect(t.checks.reconcileDue).toHaveBeenCalledOnce();
    // A request has a minute in all, and its response and the repair work before this took part of it (review P2-4).
    expect(t.checks.reconcileDue).toHaveBeenCalledWith({ budgetMs: 15_000 });
    expect(t.queue.expireStaleJobs.mock.invocationCallOrder[0]).toBeLessThan(
      t.checks.reconcileDue.mock.invocationCallOrder[0] ?? 0,
    );
  });

  // #405-T32
  it("does the check runs as often as the rest, and not when the lock is held elsewhere", async () => {
    const throttled = setup();
    await throttled.maintenance.run();
    await throttled.maintenance.run();
    expect(throttled.checks.reconcileDue).toHaveBeenCalledOnce();

    const held = setup({ held: true });
    await held.maintenance.run();
    expect(held.checks.reconcileDue).not.toHaveBeenCalled();
  });

  // #405-T32
  it("runs without a reconciler, as before the check runs", async () => {
    const t = setup({ checks: false });

    expect(await t.maintenance.run()).toBe("ran");
  });

  // #395-T11
  it("leaves a job that was queued a moment ago to the request that queued it", async () => {
    const t = setup();

    await t.maintenance.run();

    expect(t.dispatch.sendDue).toHaveBeenCalledWith(expect.any(Number), {
      minAgeMs: OPPORTUNISTIC_MIN_JOB_AGE_MS,
    });
  });

  // #395-T11
  it("does it at most once per interval, however many requests arrive", async () => {
    const t = setup();
    await t.maintenance.run();

    t.advance(OPPORTUNISTIC_INTERVAL_MS - 1);
    expect(await t.maintenance.run()).toBe("throttled");
    expect(await t.maintenance.run()).toBe("throttled");
    expect(t.queue.expireStaleJobs).toHaveBeenCalledOnce();

    t.advance(1);
    expect(await t.maintenance.run()).toBe("ran");
    expect(t.queue.expireStaleJobs).toHaveBeenCalledTimes(2);
  });

  // #395-T11
  it("does nothing while a sweep holds its lock", async () => {
    const t = setup({ held: true });

    expect(await t.maintenance.run()).toBe("locked");

    expect(t.queue.expireStaleJobs).not.toHaveBeenCalled();
    expect(t.dispatch.sendDue).not.toHaveBeenCalled();
  });

  // #395-T11
  it("never throws and logs a stable code only", async () => {
    const t = setup({ failWith: new Error("postgres://user:secret@host/db") });

    expect(await t.maintenance.run()).toBe("failed");

    expect(t.log.error).toHaveBeenCalledWith(
      "[dispatch] OPPORTUNISTIC_MAINTENANCE_FAILED",
    );
  });
});

describe("the write tokens of the Implementer in the repair work (#790)", () => {
  // #790
  it("tries the tokens that could not be switched off again, after the leases are released", async () => {
    const order: string[] = [];
    const maintenance = createOpportunisticMaintenance({
      withLock: async (work) => ({ acquired: true, value: await work() }),
      queue: {
        expireStaleJobs: vi.fn(async () => {
          order.push("expire");
          return {
            requeued: 0,
            leaseExpired: 0,
            timedOut: 0,
            noCapableRunner: 0,
          };
        }),
      },
      writeTokens: {
        retryPending: vi.fn(async () => {
          order.push("tokens");
        }),
      },
      log: { error: vi.fn() },
    });

    expect(await maintenance.run()).toBe("ran");

    expect(order).toEqual(["expire", "tokens"]);
  });
});
