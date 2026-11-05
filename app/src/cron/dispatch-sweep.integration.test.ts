// SPDX-License-Identifier: LicenseRef-Proprietary

// The sweep route of a hosted deployment (#328) against a real database: only the platform's cron may call it,
// a call without the right secret changes nothing, and two runs that overlap do not both work. , where the second run is a second connection and the lock is the
// database's own (CI).
import { describe, expect, it, vi } from "vitest";
import { createAppMetaRepository } from "../db/repositories/app-meta-repository.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { createRunnerQueue } from "../jobs/runner-queue.ts";
import { createDispatchSweep } from "../dispatch/sweep.ts";
import { createJobQueueFixture } from "../test-support/jobs.ts";
import { handleDispatchSweepCron } from "./dispatch-sweep.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const SECRET = "cron-secret-0123456789abcdef0123456789abcdef";
const serverlessEnv = { CRON_SECRET: SECRET };
const MINUTE = 60 * 1000;

const open = async () => (await createTestDatabase({ poolMax: 8 })).db;

function request(authorization?: string): Request {
  return new Request(
    "https://reviews.example.test/api/internal/dispatch-sweep",
    {
      headers: authorization === undefined ? {} : { authorization },
    },
  );
}

async function setupOn() {
  const database = await open();
  const fixture = await createJobQueueFixture({
    database,
  });
  const queue = createRunnerQueue(fixture.db, { now: fixture.clock.now });
  const cleanup = vi.fn(async () => ({
    rateLimits: 0,
    unverifiedAccounts: 0,
    verificationTokens: 0,
    passwordResetTokens: 0,
    jobClaimedKeys: 0,
    jobDispatches: 0,
  }));
  const sweep = createDispatchSweep({
    now: fixture.clock.now,
    queue,
    dispatches: createJobDispatchesRepository(fixture.db, fixture.clock.now),
    meta: createAppMetaRepository(fixture.db, fixture.clock.now),
    cleanup,
    settings: { giveUpMs: null, maxRunning: null },
    log: { info: () => undefined, error: () => undefined },
  });
  /** A job that is running with a lease that lapsed: the one thing a run changes. */
  const lapsed = async () => {
    const job = await fixture.enqueueNew({});
    await queue.claimNext("runner-1");
    fixture.clock.advance(3 * MINUTE);
    return job;
  };
  const call = (authorization?: string, env = serverlessEnv) =>
    handleDispatchSweepCron(request(authorization), {
      env,
      db: () => fixture.db,
      sweep: () => sweep,
    });
  return { fixture, queue, cleanup, sweep, lapsed, call };
}

describe("the dispatch sweep route", () => {
  const setup = () => setupOn();

  // #328-T07
  it.each([
    ["no header", undefined],
    ["a wrong secret", "Bearer not-the-secret"],
    ["another scheme", `Basic ${SECRET}`],
  ])("answers 401 for %s and changes nothing", async (_, header) => {
    const t = await setup();
    const job = await t.lapsed();

    const response = await t.call(header);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "CRON_UNAUTHORIZED" });
    expect((await t.queue.get(job.id))?.status).toBe("running");
    expect(t.cleanup).not.toHaveBeenCalled();
  });

  // #328-T07
  it("answers 401 for every caller while CRON_SECRET is missing or weak", async () => {
    const t = await setup();
    const job = await t.lapsed();

    for (const secret of [undefined, "", "short"]) {
      const response = await t.call(`Bearer ${secret ?? ""}`, {
        CRON_SECRET: secret,
      } as typeof serverlessEnv);
      expect(response.status).toBe(401);
    }

    expect((await t.queue.get(job.id))?.status).toBe("running");
  });

  // #328-T01
  it("runs the sweep for the platform's cron and answers with counts only", async () => {
    const t = await setup();
    const job = await t.lapsed();

    const response = await t.call(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      expired: {
        requeued: 1,
        leaseExpired: 0,
        timedOut: 0,
        noCapableRunner: 0,
        noRunnerAvailable: 0,
      },
      givenUp: 0,
      revived: 0,
      sent: 0,
      noticesTried: 0,
      checksSynced: 0,
      followUpsStarted: 0,
      cleanedUp: true,
      modelsDev: null,
      holdsReleased: 0,
      balanceMailsSent: 0,
      journalChecked: 0,
    });
    expect((await t.queue.get(job.id))?.status).toBe("queued");
  });

  // #328-T06
  it("skips a run that starts while another one is still working, and answers it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = await setup();
    const job = await t.lapsed();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    t.cleanup.mockImplementationOnce(async () => {
      entered();
      await held;
      return {
        rateLimits: 0,
        unverifiedAccounts: 0,
        verificationTokens: 0,
        passwordResetTokens: 0,
        jobClaimedKeys: 0,
        jobDispatches: 0,
      };
    });

    const first = t.call(`Bearer ${SECRET}`);
    await inside;
    const second = await t.call(`Bearer ${SECRET}`);
    release();
    const finished = await first;

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      status: "skipped",
      reason: "already_running",
    });
    // #395: the platform does not repeat a cron that is two hours apart: a run that did nothing is in the log.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("DISPATCH_SWEEP_SKIPPED"),
    );
    expect(finished.status).toBe(200);
    expect((await finished.json()) as { status: string }).toMatchObject({
      status: "ok",
    });
    // The skipped run did none of the work: the lapsed lease was dealt with once.
    expect((await t.queue.get(job.id))?.attempts).toBe(1);
    expect(t.cleanup).toHaveBeenCalledTimes(1);
  });

  // #328-T06
  it("runs again once the earlier run is over", async () => {
    const t = await setup();

    const first = await t.call(`Bearer ${SECRET}`);
    const second = await t.call(`Bearer ${SECRET}`);

    expect(((await first.json()) as { status: string }).status).toBe("ok");
    expect(((await second.json()) as { status: string }).status).toBe("ok");
  });

  // #328-T11
  it("answers 500 with the failed steps, and the cause of none, when a step failed", async () => {
    const t = await setup();
    t.cleanup.mockRejectedValueOnce(
      new Error("postgres://user:secret@host/db"),
    );

    const response = await t.call(`Bearer ${SECRET}`);

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      status: "error",
      failedSteps: ["cleanup"],
    });
    expect(text).not.toContain("secret@host");
  });
});
