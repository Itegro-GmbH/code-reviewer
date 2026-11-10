// SPDX-License-Identifier: LicenseRef-Proprietary

// What the dispatch does inside the request, without the sweep (#395): the bounded retries of a call that failed,
// and the jobs that were told "not now" being sent when a slot frees.
import { describe, expect, it } from "vitest";
import {
  createJobDispatchesRepository,
  WAITING_DISPATCH_CODES,
  WAITING_MIN_GAP_MS,
} from "../db/repositories/job-dispatches-repository.ts";
import { createJobQueue } from "../jobs/job-queue.ts";
import type { EnqueueJobInput, EnqueueResult } from "../jobs/job-types.ts";
import {
  accepted,
  createFakeDispatchReceiver,
  ignored,
} from "../test-support/fake-dispatch-receiver.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import type { WebhookDispatchConfig } from "./config.ts";
import { DISPATCH_RESULT_CODES, type DispatchResultCode } from "./outcome.ts";
import {
  createDispatchService,
  INLINE_RETRY_BUDGET_MS,
  INLINE_RETRY_MAX_WAIT_MS,
  REDISPATCH_SLACK_MS,
} from "./service.ts";
import { DISPATCH_TIMEOUT_MS } from "./send.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const CURRENT = {
  kid: "k2",
  secret: "example-dispatch-secret-current-00000000",
};
const webhookConfig: WebhookDispatchConfig = {
  mode: "webhook",
  url: "https://dispatcher.example.test/dispatch",
  currentKey: CURRENT,
};
const SECOND = 1000;

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

async function setupOn(options: { timeoutMs?: number } = {}) {
  const database = await open();
  const fixture = await createJobQueueFixture({
    database,
  });
  const receiver = createFakeDispatchReceiver({
    keys: [CURRENT],
    now: fixture.clock.now,
  });
  const logs = { warn: [] as string[], error: [] as string[] };
  // A clock that moves with the pauses, so the budget of the retries can be counted.
  const sleeps: number[] = [];
  const during: { pause: () => Promise<void> } = {
    pause: () => Promise.resolve(),
  };
  // A timer that fires a little before the clock of the database says the time is up (#395 review).
  const timing = { earlyMs: 0 };
  let monotonic = 0;
  const service = createDispatchService({
    db: fixture.db,
    config: webhookConfig,
    fetch: receiver.fetch,
    now: fixture.clock.now,
    timeoutMs: options.timeoutMs ?? 40,
    sleep: async (ms) => {
      sleeps.push(ms);
      monotonic += ms;
      fixture.clock.advance(Math.max(0, ms - timing.earlyMs));
      await during.pause();
    },
    monotonicMs: () => monotonic,
    log: {
      warn: (line) => logs.warn.push(line),
      error: (line) => logs.error.push(line),
    },
  });
  const work: Promise<void>[] = [];
  // How long ago the request that enqueues began, on the monotonic clock (#479): the hook of the app notes the time
  // when it is scheduled, `after()` runs it later.
  const request = { age: 0 };
  const queue = createJobQueue(fixture.db, fixture.workspaceId, {
    now: fixture.clock.now,
    onEnqueued: (result: EnqueueResult) => {
      work.push(
        service.onEnqueued(result, { receivedAt: monotonic - request.age }),
      );
    },
  });
  const enqueue = (overrides: Partial<EnqueueJobInput> = {}) =>
    queue.enqueue({
      repositoryId: fixture.repositoryId,
      prNumber: 7,
      prUrl: "https://github.test/acme/widgets/pull/7",
      headSha: sha("a"),
      command: "review",
      triggerKind: "webhook",
      actorLogin: "octocat",
      ...overrides,
    });
  return {
    fixture,
    receiver,
    logs,
    service,
    queue,
    enqueue,
    sleeps,
    during,
    timing,
    request,
    monotonic: () => monotonic,
    dispatches: createJobDispatchesRepository(fixture.db, fixture.clock.now),
    async settled() {
      await Promise.all(work);
    },
  };
}

describe("the dispatch inside the request", () => {
  const setup = (options?: { timeoutMs?: number }) => setupOn(options);

  describe("a call that failed", () => {
    // #395-T06
    it.each([
      ["503", { status: 503 }],
      ["a server error", { status: 502 }],
      ["a lost connection", { fails: "connect ECONNRESET" }],
    ])(
      "is made again inside the request after %s, until the job is acknowledged",
      async (_name, failure) => {
        const t = await setup();
        t.receiver.reply(failure, failure, accepted);

        const { job } = await t.enqueue();
        await t.settled();

        expect(t.receiver.received).toHaveLength(3);
        expect(await t.dispatches.get(job.id)).toMatchObject({
          state: "acked",
          attempts: 3,
          consecutiveFailures: 0,
          lastCode: "accepted",
        });
        // Short pauses, no sweep.
        expect(t.sleeps.length).toBe(2);
        expect(Math.max(...t.sleeps)).toBeLessThanOrEqual(10 * SECOND);
      },
    );

    // #395-T06
    it("honours a short Retry-After and every repeat is a new, verified call", async () => {
      const t = await setup();
      t.receiver.reply(
        { status: 429, headers: { "retry-after": "5" } },
        accepted,
      );

      const { job } = await t.enqueue();
      await t.settled();

      expect(t.sleeps).toEqual([5 * SECOND]);
      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "acked",
      });
      expect(t.receiver.received.map((call) => call.verdict)).toEqual([
        "ok",
        "ok",
      ]);
      expect(
        new Set(t.receiver.received.map((call) => call.body?.dispatchId)).size,
      ).toBe(2);
    });

    // #479-T01
    it.each([
      ["a 503 of a Dispatcher that is not ready (20 seconds)", 503, 20],
      ["a 429 of a busy Dispatcher (30 seconds)", 429, 30],
    ])(
      "repeats %s inside the request, and the job is acknowledged on the repeat",
      async (_what, status, seconds) => {
        const t = await setup();
        t.receiver.reply(
          { status, headers: { "retry-after": String(seconds) } },
          accepted,
        );

        const { job } = await t.enqueue();
        await t.settled();

        expect(t.sleeps).toEqual([seconds * SECOND]);
        expect(t.receiver.received).toHaveLength(2);
        expect(await t.dispatches.get(job.id)).toMatchObject({
          state: "acked",
          lastCode: "accepted",
        });
      },
    );

    // #479-T01
    it("fits the longest Retry-After it waits for, and the call after it, into the budget of the request", () => {
      expect(INLINE_RETRY_MAX_WAIT_MS).toBeGreaterThanOrEqual(30 * SECOND);
      expect(
        INLINE_RETRY_MAX_WAIT_MS + DISPATCH_TIMEOUT_MS + 5 * SECOND,
      ).toBeLessThanOrEqual(INLINE_RETRY_BUDGET_MS);
      // The function lives 60 seconds (`app/vercel.json`): the budget leaves room for the request that queued the job.
      expect(INLINE_RETRY_BUDGET_MS).toBeLessThanOrEqual(50 * SECOND);
    });

    // #479-T02
    it.each([
      ["a 503", 503],
      ["a 429", 429],
    ])(
      "does not wait inside the request for %s with a Retry-After over the cap, and the job is woken when a slot frees",
      async (_what, status) => {
        const t = await setup();
        const longer = INLINE_RETRY_MAX_WAIT_MS / SECOND + 90;
        t.receiver.reply({
          status,
          headers: { "retry-after": String(longer) },
        });

        const { job } = await t.enqueue();
        await t.settled();

        expect(t.receiver.received).toHaveLength(1);
        expect(t.sleeps).toEqual([]);
        const waiting = await t.dispatches.get(job.id);
        expect(waiting).toMatchObject({
          state: "pending",
          lastCode: status === 503 ? "unavailable" : "rate_limited",
        });
        // The row is not due for minutes, so neither the sweep nor the repair work would send it ...
        expect(await t.service.sendDue()).toEqual({ sent: 0 });
        // ... but a slot that frees (a job ended) wakes it, without a sweep and without waiting for its time.
        t.fixture.clock.advance(WAITING_MIN_GAP_MS + SECOND);
        t.receiver.reply(accepted);

        expect(await t.service.sendWaiting({ limit: 1 })).toEqual({
          sent: 1,
        });

        expect(await t.dispatches.get(job.id)).toMatchObject({
          state: "acked",
          lastCode: "accepted",
        });
      },
    );

    // #479-T09
    it("counts the budget from the start of the request, not from the first call: a request that already used 30 seconds does not wait 20 more", async () => {
      const t = await setup();
      t.request.age = 30 * SECOND;
      t.receiver.reply({ status: 503, headers: { "retry-after": "20" } });

      const { job } = await t.enqueue();
      await t.settled();

      expect(t.sleeps).toEqual([]);
      expect(t.receiver.received).toHaveLength(1);
      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "pending",
        lastCode: "unavailable",
      });
    });

    // #479-T09
    it("still repeats inside the request when the request is young", async () => {
      const t = await setup();
      t.request.age = 2 * SECOND;
      t.receiver.reply(
        { status: 503, headers: { "retry-after": "20" } },
        accepted,
      );

      const { job } = await t.enqueue();
      await t.settled();

      expect(t.sleeps).toEqual([20 * SECOND]);
      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "acked",
      });
    });

    // #395-T07
    it("stops after the bound and leaves the back-off to the next sender", async () => {
      const t = await setup();
      t.receiver.reply(...Array.from({ length: 10 }, () => ({ status: 500 })));

      const { job } = await t.enqueue();
      await t.settled();

      // The first call and three repeats.
      expect(t.receiver.received).toHaveLength(4);
      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "pending",
        attempts: 4,
        consecutiveFailures: 4,
        lastCode: "server_error",
      });
      expect((await t.queue.get(job.id))?.status).toBe("queued");
    });

    // #395-T07
    it("does not wait for a Retry-After longer than the request can afford", async () => {
      const t = await setup();
      t.receiver.reply({ status: 503, headers: { "retry-after": "600" } });

      const { job } = await t.enqueue();
      await t.settled();

      expect(t.receiver.received).toHaveLength(1);
      expect(t.sleeps).toEqual([]);
      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "pending",
        consecutiveFailures: 1,
      });
    });

    // #395-T08
    it("is not repeated when the Dispatcher refused it (an operator has to look)", async () => {
      const t = await setup();
      t.receiver.reply({ status: 401 });

      const { job } = await t.enqueue();
      await t.settled();

      expect(t.receiver.received).toHaveLength(1);
      expect(t.sleeps).toEqual([]);
      expect(await t.dispatches.get(job.id)).toMatchObject({
        lastCode: "rejected",
      });
      expect(t.logs.error.join("\n")).toContain("DISPATCH_REJECTED");
    });

    // #395-T06
    it("is not repeated for a job that was taken in the meantime", async () => {
      const t = await setup();
      t.receiver.reply({ status: 500 });
      t.during.pause = async () => {
        // The pause before the repeat is when a runner takes the job.
        await t.fixture.queue.claimNext("pool");
      };

      const { job } = await t.enqueue();
      await t.settled();

      expect(t.receiver.received).toHaveLength(1);
      expect((await t.queue.get(job.id))?.status).toBe("running");
    });
  });

  describe("a job that was told not now", () => {
    async function waitingBehindARunningJob() {
      const t = await setup();
      const first = await t.enqueue({ headSha: sha("a") });
      await t.settled();
      const claimed = await t.fixture.queue.claimNext("pool");
      if (claimed === null) throw new Error("the first job was not claimed");
      // The next push: the Dispatcher turns it away, because the pull request has a running job.
      t.receiver.reply(ignored("not_claimable"));
      const second = await t.enqueue({ headSha: sha("b") });
      await t.settled();
      return { t, first, second, claimed };
    }

    const finish = (
      t: Awaited<ReturnType<typeof setup>>,
      claimed: { job: { id: string }; leaseToken: string },
    ) =>
      t.fixture.queue.complete(claimed.job.id, claimed.leaseToken, {
        ok: true,
        result: {},
      });

    // #395-T09
    it("is sent when the running job of its pull request ends, without a sweep", async () => {
      const { t, second, claimed } = await waitingBehindARunningJob();
      expect(await t.dispatches.get(second.job.id)).toMatchObject({
        state: "pending",
        lastCode: "ignored_not_claimable",
      });
      // The row says two minutes, and nothing sweeps.
      expect(await t.service.sendDue()).toEqual({ sent: 0 });
      const before = t.receiver.received.length;

      await finish(t, claimed);
      t.fixture.clock.advance(10 * SECOND);
      const done = await t.service.sendWaiting({
        limit: 1,
        first: { repositoryId: t.fixture.repositoryId, prNumber: 7 },
      });

      expect(done).toEqual({ sent: 1 });
      expect(t.receiver.received).toHaveLength(before + 1);
      expect(t.receiver.received.at(-1)?.body?.jobId).toBe(second.job.id);
      expect(await t.dispatches.get(second.job.id)).toMatchObject({
        state: "acked",
        lastCode: "accepted",
      });
    });

    // #395-T10
    it("is sent first when it is the job of the pull request that just ended, and no more than the free slots", async () => {
      const { t, second, claimed } = await waitingBehindARunningJob();
      // Two jobs of other pull requests were turned away as well, before this one.
      t.receiver.reply(ignored("not_claimable"), ignored("not_claimable"));
      const other = await t.enqueue({
        prNumber: 8,
        prUrl: "https://github.test/acme/widgets/pull/8",
        headSha: sha("c"),
      });
      const another = await t.enqueue({
        prNumber: 9,
        prUrl: "https://github.test/acme/widgets/pull/9",
        headSha: sha("d"),
      });
      await t.settled();
      await finish(t, claimed);
      t.fixture.clock.advance(10 * SECOND);
      const before = t.receiver.received.length;

      expect(
        await t.service.sendWaiting({
          limit: 1,
          first: { repositoryId: t.fixture.repositoryId, prNumber: 7 },
        }),
      ).toEqual({ sent: 1 });

      expect(
        t.receiver.received.slice(before).map((c) => c.body?.jobId),
      ).toEqual([second.job.id]);
      // The next free slot takes the next one in line.
      expect(await t.service.sendWaiting({ limit: 2 })).toEqual({ sent: 2 });
      expect(
        t.receiver.received
          .slice(before + 1)
          .map((c) => c.body?.jobId)
          .sort(),
      ).toEqual([other.job.id, another.job.id].sort());
    });

    /** A job of another pull request that the Dispatcher turned away, with the clock moved past the gap. */
    async function refusedJob(
      t: Awaited<ReturnType<typeof setup>>,
      prNumber: number,
      letter: string,
    ) {
      t.receiver.reply(ignored("not_claimable"));
      const { job } = await t.enqueue({
        prNumber,
        prUrl: `https://github.test/acme/widgets/pull/${String(prNumber)}`,
        headSha: sha(letter),
      });
      await t.settled();
      return job;
    }

    // #395-T10
    it("is not starved by an older job that is blocked by its own pull request: the slot goes to the job that waits for the pool", async () => {
      const { t, second: blocked } = await waitingBehindARunningJob();
      const waitingForThePool = await refusedJob(t, 8, "c");
      // A job of a third pull request ends and frees a slot.
      const third = await t.enqueue({
        prNumber: 9,
        prUrl: "https://github.test/acme/widgets/pull/9",
        headSha: sha("d"),
      });
      await t.settled();
      const ended = await t.fixture.queue.claimNext("pool-2", undefined, {
        jobId: third.job.id,
      });
      if (ended === null) throw new Error("the third job was not claimed");
      await finish(t, ended);
      t.fixture.clock.advance(10 * SECOND);
      const before = t.receiver.received.length;

      const done = await t.service.sendWaiting({
        limit: 1,
        first: { repositoryId: t.fixture.repositoryId, prNumber: 9 },
      });

      // The older job is still blocked by the running job of pull request 7 and is not even asked.
      expect(done).toEqual({ sent: 1 });
      expect(
        t.receiver.received.slice(before).map((c) => c.body?.jobId),
      ).toEqual([waitingForThePool.id]);
      expect((await t.queue.get(blocked.job.id))?.status).toBe("queued");
    });

    // #395-T10
    it("asks the next job when the first one is refused again, until a wake-up is accepted", async () => {
      const t = await setup();
      const first = await refusedJob(t, 8, "c");
      t.fixture.clock.advance(SECOND);
      const second = await refusedJob(t, 9, "d");
      t.fixture.clock.advance(10 * SECOND);
      const before = t.receiver.received.length;
      // The first candidate is turned away again, the second is accepted.
      t.receiver.reply(ignored("not_claimable"), accepted);

      const done = await t.service.sendWaiting({ limit: 1 });

      expect(done).toEqual({ sent: 1 });
      expect(
        t.receiver.received.slice(before).map((c) => c.body?.jobId),
      ).toEqual([first.id, second.id]);
      expect(await t.dispatches.get(second.id)).toMatchObject({
        state: "acked",
      });
    });

    // #395-T10
    it("does not start another send after the deadline", async () => {
      const t = await setup();
      await refusedJob(t, 8, "c");
      t.fixture.clock.advance(10 * SECOND);
      const before = t.receiver.received.length;

      const done = await t.service.sendWaiting({
        limit: 1,
        deadline: t.monotonic() - 1,
      });

      expect(done).toEqual({ sent: 0 });
      expect(t.receiver.received).toHaveLength(before);
    });

    // #479-T10
    it("does not start a send that could still be running at the deadline: the longest call is counted in", async () => {
      const t = await setup({ timeoutMs: 8_000 });
      await refusedJob(t, 8, "c");
      t.fixture.clock.advance(10 * SECOND);
      const before = t.receiver.received.length;

      // A call started now may take 8 seconds: a deadline 7.9 seconds away is too near.
      expect(
        await t.service.sendWaiting({
          limit: 1,
          deadline: t.monotonic() + 7_900,
        }),
      ).toEqual({ sent: 0 });
      expect(t.receiver.received).toHaveLength(before);

      // 8.1 seconds away it fits.
      t.receiver.reply(accepted);
      expect(
        await t.service.sendWaiting({
          limit: 1,
          deadline: t.monotonic() + 8_100,
        }),
      ).toEqual({ sent: 1 });
    });

    // #479-T10
    it.each([
      ["429", { status: 429, headers: { "retry-after": "30" } }],
      ["503", { status: 503, headers: { "retry-after": "60" } }],
      ["a timeout", "hang" as const],
      ["a lost connection", { fails: "connect ECONNRESET" }],
    ])(
      "stops asking the other waiting jobs at the first %s: it says something about the Dispatcher, not about the job",
      async (_what, answer) => {
        const t = await setup();
        await refusedJob(t, 8, "c");
        await refusedJob(t, 9, "d");
        await refusedJob(t, 10, "e");
        t.fixture.clock.advance(10 * SECOND);
        const before = t.receiver.received.length;
        t.receiver.reply(answer, accepted, accepted, accepted);

        const done = await t.service.sendWaiting({ limit: 1 });

        expect(done).toEqual({ sent: 0 });
        expect(t.receiver.received.length - before).toBeLessThanOrEqual(1);
      },
    );

    // #479-T10
    it("keeps asking the next job when one is turned away for its own pull request (not_claimable says nothing of the Dispatcher)", async () => {
      const t = await setup();
      const one = await refusedJob(t, 8, "c");
      const two = await refusedJob(t, 9, "d");
      t.fixture.clock.advance(10 * SECOND);
      const before = t.receiver.received.length;
      t.receiver.reply(ignored("not_claimable"), accepted);

      expect(await t.service.sendWaiting({ limit: 1 })).toEqual({ sent: 1 });
      expect(t.receiver.received.length - before).toBe(2);
      // Both were asked, one after the other (the order of equal times is the id's), and the second took the slot.
      const asked = t.receiver.received.slice(before).map((c) => c.body?.jobId);
      expect([...asked].sort()).toEqual([one.id, two.id].sort());
    });

    // #395-T10
    it("never sends a job twice when two events ask for the same waiting job at once", async () => {
      const t = await setup();
      const job = await refusedJob(t, 8, "c");
      t.fixture.clock.advance(10 * SECOND);
      const before = t.receiver.received.length;

      const results = await Promise.all([
        t.service.sendWaiting({ limit: 1 }),
        t.service.sendWaiting({ limit: 1 }),
        t.service.sendWaiting({ limit: 1 }),
      ]);

      expect(results.reduce((sum, r) => sum + r.sent, 0)).toBe(1);
      expect(
        t.receiver.received.slice(before).map((c) => c.body?.jobId),
      ).toEqual([job.id]);
      expect(await t.dispatches.get(job.id)).toMatchObject({
        attempts: 2,
        state: "acked",
      });
    });

    // #395-T10
    it("does not take over a send that is in flight", async () => {
      const t = await setup();
      const job = await refusedJob(t, 8, "c");
      t.fixture.clock.advance(10 * SECOND);
      // An event is sending the job right now: its lease holds the row.
      expect(
        await t.dispatches.claimSend(
          job.id,
          (await t.dispatches.get(job.id))?.nextDispatchAt ?? "",
          new Date(t.fixture.clock.now().getTime() + 30 * SECOND),
        ),
      ).toBe(true);
      const before = t.receiver.received.length;

      expect(await t.service.sendWaiting({ limit: 1 })).toEqual({ sent: 0 });
      expect(t.receiver.received).toHaveLength(before);
    });

    // #479-T02
    it.each<[string, DispatchResultCode, number]>([
      ["429 busy", "rate_limited", 429],
      ["503 unavailable", "unavailable", 503],
    ])(
      "sends a job the Dispatcher answered with %s when a slot frees, before its Retry-After is over, but not while its last call may still be in flight",
      async (_what, lastCode, lastStatus) => {
        const t = await setup();
        const busy = await refusedJob(t, 9, "d");
        await t.dispatches.record(
          busy.id,
          {
            state: "pending",
            nextDispatchAt: new Date(
              t.fixture.clock.now().getTime() + 600 * SECOND,
            ),
            consecutiveFailures: 1,
            acknowledged: false,
            lastStatus,
            lastCode,
            alert: false,
          },
          t.fixture.clock.now(),
        );
        const before = t.receiver.received.length;

        // The call just made may still be in flight: its row is left alone.
        expect(await t.service.sendWaiting({ limit: 5 })).toEqual({
          sent: 0,
        });
        expect(t.receiver.received).toHaveLength(before);

        t.fixture.clock.advance(WAITING_MIN_GAP_MS + SECOND);
        t.receiver.reply(accepted);
        expect(await t.service.sendWaiting({ limit: 5 })).toEqual({
          sent: 1,
        });
        expect(t.receiver.received.at(-1)?.body?.jobId).toBe(busy.id);
      },
    );

    // #972-T02
    it("rests a job the Dispatcher answered busy: the repair work and the sweep leave it alone, and a freed slot asks it again", async () => {
      const t = await setup();
      t.receiver.reply(ignored("busy"));
      const { job } = await t.enqueue({
        prNumber: 12,
        prUrl: "https://github.test/acme/widgets/pull/12",
        headSha: sha("e"),
      });
      await t.settled();
      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "pending",
        lastCode: "ignored_busy",
        consecutiveFailures: 0,
      });
      const before = t.receiver.received.length;

      // Ten minutes later no timer and no sweep rings it: its rest is the period of the cron.
      t.fixture.clock.advance(10 * 60 * SECOND);
      expect(await t.service.sendDue()).toEqual({ sent: 0 });
      expect(t.receiver.received).toHaveLength(before);

      // A job ended: the slot that freed rings it again, whatever time its row says.
      t.receiver.reply(accepted);
      expect(await t.service.sendWaiting({ limit: 5 })).toEqual({ sent: 1 });
      expect(t.receiver.received.at(-1)?.body?.jobId).toBe(job.id);
    });

    // #479-T03
    it("lists exactly the answers that mean 'not now' as waiting, whatever time their row says", async () => {
      const t = await setup();
      const listed: DispatchResultCode[] = [];
      for (const [index, code] of DISPATCH_RESULT_CODES.entries()) {
        const job = await refusedJob(t, 50 + index, String(index % 10));
        await t.dispatches.record(
          job.id,
          {
            state: "pending",
            nextDispatchAt: new Date(
              t.fixture.clock.now().getTime() + 3600 * SECOND,
            ),
            consecutiveFailures: 0,
            acknowledged: false,
            lastStatus: null,
            lastCode: code,
            alert: false,
          },
          t.fixture.clock.now(),
        );
        t.fixture.clock.advance(WAITING_MIN_GAP_MS + SECOND);
        const waiting = await t.dispatches.listWaiting(
          t.fixture.clock.now(),
          100,
        );
        if (waiting.some((entry) => entry.jobId === job.id)) listed.push(code);
      }

      expect([...listed].sort()).toEqual([...WAITING_DISPATCH_CODES].sort());
      // #972: a Dispatcher that said `busy` (it is full and forgets the bell) is asked when a slot frees.
      expect([...WAITING_DISPATCH_CODES].sort()).toEqual(
        [
          "ignored_not_claimable",
          "ignored_busy",
          "rate_limited",
          "unavailable",
        ].sort(),
      );
    });

    // #395-T10
    it("sends nothing at the pool cap (no free slot) and nothing for a job that is not waiting", async () => {
      const { t } = await waitingBehindARunningJob();
      const before = t.receiver.received.length;

      expect(await t.service.sendWaiting({ limit: 0 })).toEqual({ sent: 0 });
      // A job that was acknowledged is not "waiting": its own look comes after the acknowledgement timeout.
      const { job } = await t.enqueue({
        prNumber: 11,
        prUrl: "https://github.test/acme/widgets/pull/11",
        headSha: sha("e"),
      });
      await t.settled();
      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "acked",
      });
      const sent = t.receiver.received.length;

      await t.service.sendWaiting({ limit: 5 });

      // Only the job that was turned away is sent again, never the acknowledged one.
      expect(
        t.receiver.received.slice(sent).every((c) => c.body?.jobId !== job.id),
      ).toBe(true);
      expect(before).toBeLessThanOrEqual(sent);
    });
  });

  describe("the repair work of the other requests", () => {
    // #395-T11
    it("leaves a job that was queued a moment ago to the request that queued it, and sends it once it is older", async () => {
      const t = await setup();
      // A job whose hook never ran: queued through the fixture, no row.
      const { job } = await t.fixture.enqueue();
      t.fixture.clock.advance(10 * SECOND);

      expect(await t.service.sendDue(20, { minAgeMs: 40 * SECOND })).toEqual({
        sent: 0,
      });
      expect(t.receiver.received).toHaveLength(0);

      t.fixture.clock.advance(31 * SECOND);
      expect(await t.service.sendDue(20, { minAgeMs: 40 * SECOND })).toEqual({
        sent: 1,
      });
      expect(t.receiver.received.map((call) => call.body?.jobId)).toEqual([
        job.id,
      ]);
    });
  });

  describe("the senders overlapping", () => {
    // #395-T11
    it("never send a job twice when the sweep, the repair work of a request and a job that ended all find it", async () => {
      const t = await setup();
      // A job whose hook never ran: no row, due, old enough for every sender.
      const { job } = await t.fixture.enqueue();
      t.fixture.clock.advance(60 * SECOND);

      await Promise.all([
        t.service.sendDue(20),
        t.service.sendDue(20, { minAgeMs: 40 * SECOND }),
        t.service.sendDue(20, { minAgeMs: 40 * SECOND }),
        t.service.sendWaiting({ limit: 1 }),
      ]);

      expect(t.receiver.received.map((call) => call.body?.jobId)).toEqual([
        job.id,
      ]);
      expect(await t.dispatches.get(job.id)).toMatchObject({
        attempts: 1,
        state: "acked",
      });
    });
  });

  describe("a job that was given back", () => {
    // #395-T09
    it("is sent again at once", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();
      const claimed = await t.fixture.queue.claimNext("pool");
      expect(claimed?.job.id).toBe(job.id);
      const sent = t.receiver.received.length;
      const released = await t.fixture.queue.release(
        job.id,
        claimed?.leaseToken ?? "",
        "launch_failed",
      );
      expect(released.status).toBe("requeued");

      await t.service.redispatch(job.id);

      expect(t.receiver.received).toHaveLength(sent + 1);
      expect(t.receiver.received.at(-1)?.body).toMatchObject({
        jobId: job.id,
        attempt: 2,
      });
      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "acked",
      });
    });

    // #395-T09
    it("waits for its retry time (the Dispatcher gives a job back with 30 seconds) and leaves a longer one to the next sender", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();
      const claimed = await t.fixture.queue.claimNext("pool");
      await t.fixture.queue.release(
        job.id,
        claimed?.leaseToken ?? "",
        "launch_failed",
        {
          retryAt: new Date(t.fixture.clock.now().getTime() + 30 * SECOND),
        },
      );
      const sent = t.receiver.received.length;

      await t.service.redispatch(job.id);

      expect(t.sleeps).toEqual([30 * SECOND + REDISPATCH_SLACK_MS]);
      expect(t.receiver.received).toHaveLength(sent + 1);

      // Another give-back with a retry far away: nothing is sent now, the row is due at the retry time.
      const again = await t.fixture.queue.claimNext("pool");
      expect(again?.job.id).toBe(job.id);
      await t.fixture.queue.release(
        job.id,
        again?.leaseToken ?? "",
        "launch_failed",
        {
          retryAt: new Date(t.fixture.clock.now().getTime() + 60 * SECOND),
        },
      );
      const afterSecond = t.receiver.received.length;
      await t.service.redispatch(job.id);
      expect(t.receiver.received).toHaveLength(afterSecond);
    });

    // #395-T09
    it("does not sleep for a retry time that does not fit before the deadline, and leaves the job to the next sender", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();
      const claimed = await t.fixture.queue.claimNext("pool");
      await t.fixture.queue.release(
        job.id,
        claimed?.leaseToken ?? "",
        "launch_failed",
        { retryAt: new Date(t.fixture.clock.now().getTime() + 30 * SECOND) },
      );
      const sent = t.receiver.received.length;

      // 30 s, the slack and a send do not fit in 20 s.
      await t.service.redispatch(job.id, {
        deadline: t.monotonic() + 20 * SECOND,
      });

      expect(t.sleeps).toEqual([]);
      expect(t.receiver.received).toHaveLength(sent);
      // Later, when the time has come, the sweep (or the repair work of a request) sends it.
      t.fixture.clock.advance(31 * SECOND);
      expect(await t.service.sendDue()).toEqual({ sent: 1 });
    });

    // #395-T09
    it("sends the job although the timer fired a little before the clock of the database says it is time", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();
      const claimed = await t.fixture.queue.claimNext("pool");
      await t.fixture.queue.release(
        job.id,
        claimed?.leaseToken ?? "",
        "launch_failed",
        { retryAt: new Date(t.fixture.clock.now().getTime() + 30 * SECOND) },
      );
      const sent = t.receiver.received.length;
      t.timing.earlyMs = 100;

      await t.service.redispatch(job.id);

      expect(t.receiver.received).toHaveLength(sent + 1);
    });

    // #395-T09
    it("does nothing for a job that is not queued", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();
      const claimed = await t.fixture.queue.claimNext("pool");
      const sent = t.receiver.received.length;

      await t.service.redispatch(job.id);

      expect(claimed?.job.id).toBe(job.id);
      expect(t.receiver.received).toHaveLength(sent);
    });
  });
});
