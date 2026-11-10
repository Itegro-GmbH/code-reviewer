// SPDX-License-Identifier: LicenseRef-Proprietary

// The queue tells its owner which jobs lost their running claim (#487), so that the Dispatcher can be told to stop their
// VMs: a result, a failure, a cancel, a job given back, a superseded run's report, a lease that ran out (in the expiry
// call and in the expiry step of a claim) and a runtime past the hard limit.  The callback runs after the transaction committed, once per call, and never for a call that ended
// nothing.
import { describe, expect, it, vi } from "vitest";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

const OK = { ok: true, result: {} } as const;
const FAILED = { ok: false, errorCode: "unknown", result: null } as const;

describe("the claims a call ended", () => {
  async function start(
    options: Parameters<typeof createJobQueueFixture>[0] = {},
  ) {
    const database = await open();
    const ended: string[][] = [];
    const requeued: string[][] = [];
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      ...options,
      onClaimsEnded: (jobIds) => ended.push([...jobIds]),
      onRequeued: (jobIds) => requeued.push([...jobIds]),
    });
    async function running(
      overrides: Parameters<typeof fixture.enqueue>[0] = {},
      claim: Parameters<typeof fixture.queue.claimNext>[2] = {},
    ) {
      const queued = await fixture.enqueueNew(overrides);
      const claimed = await fixture.queue.claimNext("pool", undefined, {
        jobId: queued.id,
        ...claim,
      });
      if (claimed === null) throw new Error("the job was not claimed");
      return claimed.job;
    }
    return { fixture, ended, requeued, running };
  }

  // #487-T06
  it("names the job whose result was delivered", async () => {
    const { fixture, ended, running } = await start();
    const job = await running();

    const result = await fixture.queue.complete(
      job.id,
      await fixture.tokenOf(job.id),
      OK,
    );

    expect(result.status).toBe("completed");
    expect(ended).toEqual([[job.id]]);
  });

  // #487-T06
  it("names the job that failed", async () => {
    const { fixture, ended, running } = await start();
    const job = await running();

    await fixture.queue.complete(job.id, await fixture.tokenOf(job.id), FAILED);

    expect(ended).toEqual([[job.id]]);
    expect((await fixture.queue.get(job.id))?.status).toBe("failed");
  });

  // #487-T06
  it("names the job that was cancelled while it ran", async () => {
    const { fixture, ended, running } = await start();
    const job = await running();

    const result = await fixture.queue.cancelClaimed(
      job.id,
      await fixture.tokenOf(job.id),
      "project_deactivated",
    );

    expect(result.status).toBe("cancelled");
    expect(ended).toEqual([[job.id]]);
  });

  // #487-T06
  it("names a superseded job when its holder reports, and not when it is superseded", async () => {
    const { fixture, ended, running } = await start();
    const old = await running(
      { headSha: sha("a") },
      { acceptsSupersede: true },
    );
    await fixture.enqueue({ headSha: sha("b") });
    expect((await fixture.queue.get(old.id))?.status).toBe("superseded");
    expect(ended).toEqual([]);

    const result = await fixture.queue.complete(
      old.id,
      await fixture.tokenOf(old.id),
      FAILED,
    );

    expect(result.status).toBe("completed");
    expect(ended).toEqual([[old.id]]);
  });

  // #487-T06
  it("names a job given back on its last attempt, and not one that went back to the queue", async () => {
    const { fixture, ended, requeued, running } = await start({
      limits: { maxAttempts: 2 },
    });
    const job = await running();

    expect(
      (
        await fixture.queue.release(
          job.id,
          await fixture.tokenOf(job.id),
          "launch_failed",
        )
      ).status,
    ).toBe("requeued");
    // The next attempt may have its VM already when the Dispatcher is told: a requeued job is not stopped.
    expect(ended).toEqual([]);
    // It waits again, and a webhook dispatcher is told so (#972).
    expect(requeued).toEqual([[job.id]]);

    const again = await fixture.queue.claimNext("pool", undefined, {
      jobId: job.id,
    });
    expect(again?.job.id).toBe(job.id);
    expect(
      (
        await fixture.queue.release(
          job.id,
          await fixture.tokenOf(job.id),
          "launch_failed",
        )
      ).status,
    ).toBe("failed");
    expect(ended).toEqual([[job.id]]);
  });

  // #487-T06
  it("names the jobs whose lease ran out and ended them, and not the one that went back to the queue", async () => {
    const { fixture, ended, running } = await start({
      limits: { maxAttempts: 2 },
    });
    const lastTry = await running({
      prNumber: 1,
      prUrl: "https://github.test/acme/widgets/pull/1",
    });
    fixture.clock.advance(3 * MINUTE);
    await fixture.queue.expireStaleJobs();
    expect((await fixture.queue.get(lastTry.id))?.status).toBe("queued");
    expect(ended).toEqual([]);
    await fixture.queue.claimNext("pool", undefined, { jobId: lastTry.id });
    const fresh = await running({
      prNumber: 2,
      prUrl: "https://github.test/acme/widgets/pull/2",
    });
    fixture.clock.advance(3 * MINUTE);

    const report = await fixture.queue.expireStaleJobs();

    expect(report).toMatchObject({ requeued: 1, leaseExpired: 1 });
    expect(ended).toEqual([[lastTry.id]]);
    expect((await fixture.queue.get(fresh.id))?.status).toBe("queued");
  });

  // #972-T03
  it("names the jobs a lapsed lease put back in the queue as requeued, and not the one it failed", async () => {
    const { fixture, ended, requeued, running } = await start({
      limits: { maxAttempts: 2 },
    });
    const lastTry = await running({
      prNumber: 1,
      prUrl: "https://github.test/acme/widgets/pull/1",
    });
    fixture.clock.advance(3 * MINUTE);
    await fixture.queue.expireStaleJobs();
    expect(requeued).toEqual([[lastTry.id]]);
    await fixture.queue.claimNext("pool", undefined, { jobId: lastTry.id });
    requeued.length = 0;
    const fresh = await running({
      prNumber: 2,
      prUrl: "https://github.test/acme/widgets/pull/2",
    });
    fixture.clock.advance(3 * MINUTE);

    await fixture.queue.expireStaleJobs();

    // The first job failed on its last attempt (ended, not requeued); the second is waiting again.
    expect(ended).toEqual([[lastTry.id]]);
    expect(requeued).toEqual([[fresh.id]]);
  });

  // #972-T03
  it("names nothing as requeued for a lapsed lease whose job the same claim handed to a new holder, and nothing when no lease lapsed", async () => {
    const { fixture, requeued, running } = await start();
    await fixture.queue.expireStaleJobs();
    expect(requeued).toEqual([]);
    const job = await running();
    fixture.clock.advance(3 * MINUTE);

    const claimed = await fixture.queue.claimNext("other-pool");

    expect(claimed?.job.id).toBe(job.id);
    expect(requeued).toEqual([]);
  });

  // #972-T03
  it("names the job a claim found with a lapsed lease and left in the queue", async () => {
    const { fixture, requeued, running } = await start();
    const lapsed = await running({
      prNumber: 1,
      prUrl: "https://github.test/acme/widgets/pull/1",
    });
    const other = await fixture.enqueueNew({
      prNumber: 2,
      prUrl: "https://github.test/acme/widgets/pull/2",
    });
    fixture.clock.advance(3 * MINUTE);

    // The claim is for the other job; the one whose lease lapsed goes back to the queue and stays there.
    const claimed = await fixture.queue.claimNext("other-pool", undefined, {
      jobId: other.id,
    });

    expect(claimed?.job.id).toBe(other.id);
    expect((await fixture.queue.get(lapsed.id))?.status).toBe("queued");
    expect(requeued).toEqual([[lapsed.id]]);
  });

  // #487-T06
  it("names the job whose lapsed lease a claim found", async () => {
    const { fixture, ended, running } = await start({
      limits: { maxAttempts: 1 },
    });
    const job = await running();
    fixture.clock.advance(3 * MINUTE);

    const claimed = await fixture.queue.claimNext("other-pool");

    expect(claimed).toBeNull();
    expect(ended).toEqual([[job.id]]);
    expect((await fixture.queue.get(job.id))?.errorCode).toBe("lease_expired");
  });

  // #487-T06
  it("names nothing for a lapsed lease of a job that a claim found and handed to a new holder", async () => {
    const { fixture, ended, running } = await start();
    const job = await running();
    fixture.clock.advance(3 * MINUTE);

    const claimed = await fixture.queue.claimNext("other-pool");

    expect(claimed?.job.id).toBe(job.id);
    expect(ended).toEqual([]);
  });

  // #487-T06
  it("names the job that ran past the hard limit, found by a heartbeat and by the expiry", async () => {
    const { fixture, ended, running } = await start();
    const first = await running({
      prNumber: 1,
      prUrl: "https://github.test/acme/widgets/pull/1",
    });
    const second = await running({
      prNumber: 2,
      prUrl: "https://github.test/acme/widgets/pull/2",
    });
    for (let minute = 1; minute <= 25; minute++) {
      fixture.clock.advance(MINUTE);
      if (minute < 25) {
        await fixture.queue.heartbeat(
          second.id,
          await fixture.tokenOf(second.id),
        );
        await fixture.queue.heartbeat(
          first.id,
          await fixture.tokenOf(first.id),
        );
      }
    }
    expect(ended).toEqual([]);

    await fixture.queue.heartbeat(first.id, await fixture.tokenOf(first.id));
    expect(ended).toEqual([[first.id]]);
    expect((await fixture.queue.get(first.id))?.errorCode).toBe("timeout");

    const report = await fixture.queue.expireStaleJobs();
    expect(report.timedOut).toBe(1);
    expect(ended).toEqual([[first.id], [second.id]]);
  });

  // #487-T06
  it("names nothing for a call that ended no claim", async () => {
    const { fixture, ended, running } = await start();
    const job = await running();
    const token = await fixture.tokenOf(job.id);

    await fixture.queue.heartbeat(job.id, token);
    await fixture.queue.complete(job.id, token, OK);
    ended.length = 0;
    // The same report again, a stranger's token, a job that waits, and an expiry with nothing to expire.
    await fixture.queue.complete(job.id, token, OK);
    await fixture.queue.complete(job.id, "not-the-token", OK);
    await fixture.queue.cancelClaimed(job.id, token, "project_deactivated");
    await fixture.queue.release(job.id, token, "runner_shutdown");
    await fixture.enqueueNew({
      prNumber: 3,
      prUrl: "https://github.test/acme/widgets/pull/3",
    });
    await fixture.queue.expireStaleJobs();

    expect(ended).toEqual([]);
  });

  // #487-T07
  it("does not fail the call when the callback throws", async () => {
    const database = await open();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      onClaimsEnded: () => {
        throw new Error("the stop is down");
      },
    });
    const job = await fixture.enqueueNew();
    await fixture.queue.claimNext("pool", undefined, { jobId: job.id });
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });

    try {
      const result = await fixture.queue.complete(
        job.id,
        await fixture.tokenOf(job.id),
        OK,
      );

      expect(result.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
    expect((await fixture.queue.get(job.id))?.status).toBe("succeeded");
    // Logged once by its own stable code, not by the code of another callback, and without the error's text.
    expect(errors).toEqual(["[queue] claims_ended_callback_failed"]);
  });

  // #972-T03
  it("logs a requeue callback that throws by its own code and still answers", async () => {
    const database = await open();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      onRequeued: () => {
        throw new Error("the doorbell is down");
      },
    });
    const job = await fixture.enqueueNew();
    await fixture.queue.claimNext("pool", undefined, { jobId: job.id });
    fixture.clock.advance(3 * MINUTE);
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });

    try {
      expect(await fixture.queue.expireStaleJobs()).toMatchObject({
        requeued: 1,
      });
    } finally {
      spy.mockRestore();
    }
    expect(errors).toEqual(["[queue] requeued_callback_failed"]);
  });
});
