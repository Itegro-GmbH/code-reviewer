// SPDX-License-Identifier: LicenseRef-Proprietary

// The dispatch webhook against a real Postgres database (#326): the hook on the job queue, the signed request
// to a stand-in for the Dispatcher, the rows of `job_dispatches`, and the resends the sweep (#328) will drive
// through `sendDue`.
import { describe, expect, it } from "vitest";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { createJobQueue } from "../jobs/job-queue.ts";
import type { EnqueueJobInput, EnqueueResult } from "../jobs/job-types.ts";
import {
  accepted,
  createFakeDispatchReceiver,
  ignored,
} from "../test-support/fake-dispatch-receiver.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import type { WebhookDispatchConfig } from "./config.ts";
import { ACK_TIMEOUT_MS, REJECTED_BACKOFF_MS } from "./outcome.ts";
import { createDispatchService } from "./service.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";

const CURRENT = {
  kid: "k2",
  secret: "example-dispatch-secret-current-00000000",
};
const PREVIOUS = {
  kid: "k1",
  secret: "example-dispatch-secret-previous-0000000",
};
const URL_OK = "https://dispatcher.example.test/dispatch";
const SECOND = 1000;
const MINUTE = 60 * SECOND;

const webhookConfig: WebhookDispatchConfig = {
  mode: "webhook",
  url: URL_OK,
  currentKey: CURRENT,
  previousKey: PREVIOUS,
};

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

async function setupOn(options: { dynamicReview?: boolean } = {}) {
  const database = await open();
  const fixture = await createJobQueueFixture({
    database,
    ...(options.dynamicReview === true ? { dynamicReview: true } : {}),
  });
  const receiver = createFakeDispatchReceiver({
    keys: [CURRENT, PREVIOUS],
    now: fixture.clock.now,
  });
  const logs = { warn: [] as string[], error: [] as string[] };
  const service = createDispatchService({
    db: fixture.db,
    config: webhookConfig,
    fetch: receiver.fetch,
    now: fixture.clock.now,
    timeoutMs: 40,
    // The resends below are driven by the test (`sendDue`); the retries inside the request have their own test.
    inlineRetryDelaysMs: [],
    log: {
      warn: (line) => logs.warn.push(line),
      error: (line) => logs.error.push(line),
    },
  });
  // What `after()` does in the app: the work starts once the enqueue has returned, and the test waits for it.
  const work: Promise<void>[] = [];
  const queue = createJobQueue(fixture.db, fixture.workspaceId, {
    now: fixture.clock.now,
    ...(options.dynamicReview === true
      ? { dynamicReviewEnabled: () => Promise.resolve(true) }
      : {}),
    onEnqueued: (result: EnqueueResult) => {
      work.push(service.onEnqueued(result));
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
    dispatches: createJobDispatchesRepository(fixture.db, fixture.clock.now),
    /** Waits for the work the hook scheduled. */
    async settled() {
      await Promise.all(work);
    },
    async rows() {
      return fixture.db.selectFrom("job_dispatches").selectAll().execute();
    },
  };
}

describe("the dispatch webhook", () => {
  const setup = (options: { dynamicReview?: boolean } = {}) => setupOn(options);

  describe("the dispatch webhook after a job is queued", () => {
    // #326-T01
    it("sends one signed request for a new job, and the receiver's verdict is ok", async () => {
      const t = await setup();

      const result = await t.enqueue();
      await t.settled();

      expect(result.status).toBe("created");
      expect(t.receiver.received).toHaveLength(1);
      const call = t.receiver.received[0];
      expect(call?.verdict).toBe("ok");
      expect(call?.url).toBe(URL_OK);
      expect(call?.headers["x-dispatch-key-id"]).toBe("k2");
      expect(call?.body).toEqual({
        version: 1,
        type: "job.ready",
        jobId: result.job.id,
        reviewKind: "diff",
        attempt: 1,
        dispatchId: call?.headers["x-dispatch-id"],
        sentAt: t.fixture.clock.now().toISOString(),
      });
      const row = await t.dispatches.get(result.job.id);
      expect(row).toMatchObject({
        state: "acked",
        attempts: 1,
        consecutiveFailures: 0,
        lastStatus: 202,
        lastCode: "accepted",
        ackedAt: t.fixture.clock.now().toISOString(),
      });
    });

    // #326-T01
    it("names the review kind of a Dynamic job", async () => {
      const t = await setup({ dynamicReview: true });

      const result = await t.enqueue({ reviewKind: "dynamic" });
      await t.settled();

      expect(result.job.reviewKind).toBe("dynamic");
      expect(t.receiver.received.map((call) => call.body?.reviewKind)).toEqual([
        "dynamic",
      ]);
    });

    // #752-T10
    it("names the review kind of an implementer turn, and a waiting turn is sent again with it", async () => {
      const t = await setup();
      await addUser(t.fixture.db, "user-1");

      const result = await t.queue.enqueueImplementerTurn({
        repositoryId: t.fixture.repositoryId,
        baseBranch: "main",
        baseSha: sha("b"),
        branch: "implementer/abc",
        instruction: "Do it.",
        modelChoice: { entryId: "entry-1" },
        costLimitCents: null,
        createdBy: "user-1",
        actorLogin: "octocat",
        clientRequestId: "req-1",
      });
      await t.settled();

      expect(result.status).toBe("created");
      expect(t.receiver.received.map((call) => call.body?.reviewKind)).toEqual([
        "implementer",
      ]);
      expect(
        await t.dispatches.dueJob(result.job.id, t.fixture.clock.now()),
      ).toEqual({
        jobId: result.job.id,
        reviewKind: "implementer",
        jobAttempts: 0,
      });
    });

    // #326-T06
    it("does nothing for a job that was created already failed (Dynamic Review is off)", async () => {
      const t = await setup();

      const result = await t.enqueue({ reviewKind: "dynamic" });
      await t.settled();

      expect(result.job.status).toBe("failed");
      expect(t.receiver.received).toHaveLength(0);
      expect(await t.rows()).toEqual([]);
    });

    // #326-T06
    it("leaves the job queued and the enqueue unaffected when the endpoint hangs", async () => {
      const t = await setup();
      t.receiver.reply("hang");

      const result = await t.enqueue();
      // The enqueue came back while the send was still waiting for the endpoint.
      expect((await t.queue.get(result.job.id))?.status).toBe("queued");
      await t.settled();

      expect((await t.queue.get(result.job.id))?.status).toBe("queued");
      expect(await t.dispatches.get(result.job.id)).toMatchObject({
        state: "pending",
        attempts: 1,
        consecutiveFailures: 1,
        lastStatus: null,
        lastCode: "timeout",
      });
    });

    // #326-T06
    it("leaves the job queued when the connection fails or the endpoint answers 500", async () => {
      const t = await setup();
      t.receiver.reply({ fails: "connect ECONNREFUSED" }, { status: 500 });

      const first = await t.enqueue({
        prNumber: 1,
        prUrl: "https://github.test/acme/widgets/pull/1",
      });
      const second = await t.enqueue({
        prNumber: 2,
        prUrl: "https://github.test/acme/widgets/pull/2",
      });
      await t.settled();

      for (const result of [first, second])
        expect((await t.queue.get(result.job.id))?.status).toBe("queued");
      expect(
        (await t.rows()).map((row) => [
          row.last_code,
          row.consecutive_failures,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["network_error", 1],
          ["server_error", 1],
        ]),
      );
    });

    // #326-T06
    it("never rejects, even when the database under the dispatch fails", async () => {
      const t = await setup();
      await t.fixture.db.schema.dropTable("job_dispatches").execute();

      const result = await t.enqueue();
      await expect(t.settled()).resolves.toBeUndefined();

      expect((await t.queue.get(result.job.id))?.status).toBe("queued");
      expect(t.receiver.received).toHaveLength(0);
      expect(t.logs.error).toHaveLength(1);
      expect(t.logs.error[0]).toContain(
        `[dispatch] DISPATCH_FAILED job=${result.job.id}`,
      );
    });
  });

  describe("the resends", () => {
    // #326-T03
    it("resends on the back-off schedule after a 5xx and then marks the job acknowledged", async () => {
      const t = await setup();
      t.receiver.reply({ status: 502 }, { status: 504 }, accepted);

      const { job } = await t.enqueue();
      await t.settled();
      expect(t.receiver.received).toHaveLength(1);
      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "pending",
        consecutiveFailures: 1,
        lastStatus: 502,
        nextDispatchAt: new Date(
          t.fixture.clock.now().getTime() + 10 * SECOND,
        ).toISOString(),
      });

      // Not yet due: nothing is sent.
      t.fixture.clock.advance(9 * SECOND);
      expect(await t.service.sendDue()).toEqual({ sent: 0 });
      expect(t.receiver.received).toHaveLength(1);

      t.fixture.clock.advance(1 * SECOND);
      expect(await t.service.sendDue()).toEqual({ sent: 1 });
      expect(t.receiver.received).toHaveLength(2);
      expect(await t.dispatches.get(job.id)).toMatchObject({
        consecutiveFailures: 2,
        lastStatus: 504,
        attempts: 2,
        nextDispatchAt: new Date(
          t.fixture.clock.now().getTime() + 30 * SECOND,
        ).toISOString(),
      });

      t.fixture.clock.advance(30 * SECOND);
      expect(await t.service.sendDue()).toEqual({ sent: 1 });
      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "acked",
        consecutiveFailures: 0,
        attempts: 3,
        lastCode: "accepted",
      });
      // Every send is a new call: a new dispatch id, and every one verifies.
      expect(
        new Set(t.receiver.received.map((c) => c.body?.dispatchId)).size,
      ).toBe(3);
      expect(t.receiver.received.map((c) => c.verdict)).toEqual([
        "ok",
        "ok",
        "ok",
      ]);
    });

    // #326-T03
    it("follows 10 s, 30 s, 2 min, 5 min and then 15 min while the receiver keeps failing", async () => {
      const t = await setup();
      t.receiver.reply(...Array.from({ length: 7 }, () => ({ status: 500 })));

      const { job } = await t.enqueue();
      await t.settled();
      const waits: number[] = [];
      for (let step = 0; step < 6; step += 1) {
        const row = await t.dispatches.get(job.id);
        const wait =
          Date.parse(row?.nextDispatchAt ?? "") -
          t.fixture.clock.now().getTime();
        waits.push(wait);
        t.fixture.clock.advance(wait);
        await t.service.sendDue();
      }

      expect(waits).toEqual([
        10 * SECOND,
        30 * SECOND,
        2 * MINUTE,
        5 * MINUTE,
        15 * MINUTE,
        15 * MINUTE,
      ]);
      expect(t.receiver.received).toHaveLength(7);
    });

    // #326-T04
    it("waits for a Retry-After that is longer than the schedule", async () => {
      const t = await setup();
      t.receiver.reply({ status: 429, headers: { "retry-after": "600" } });

      const { job } = await t.enqueue();
      await t.settled();

      expect(await t.dispatches.get(job.id)).toMatchObject({
        lastCode: "rate_limited",
        nextDispatchAt: new Date(
          t.fixture.clock.now().getTime() + 600 * SECOND,
        ).toISOString(),
      });
      t.fixture.clock.advance(599 * SECOND);
      expect(await t.service.sendDue()).toEqual({ sent: 0 });
      t.fixture.clock.advance(1 * SECOND);
      expect(await t.service.sendDue()).toEqual({ sent: 1 });
      expect(t.receiver.received).toHaveLength(2);
    });

    // #326-T05
    it("waits long after any other 4xx, raises an alert, and does not loop hot", async () => {
      const t = await setup();
      t.receiver.reply({ status: 401, body: '{"error":"nope"}' });

      const { job } = await t.enqueue();
      await t.settled();

      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "pending",
        lastStatus: 401,
        lastCode: "rejected",
        nextDispatchAt: new Date(
          t.fixture.clock.now().getTime() + REJECTED_BACKOFF_MS,
        ).toISOString(),
      });
      expect(t.logs.error).toHaveLength(1);
      expect(t.logs.error[0]).toContain("DISPATCH_REJECTED");
      expect(t.logs.error[0]).toContain("status=401");
      // The sweep may run every minute for half an hour; nothing is sent.
      for (let minute = 0; minute < 29; minute += 1) {
        t.fixture.clock.advance(MINUTE);
        expect(await t.service.sendDue()).toEqual({ sent: 0 });
      }
      expect(t.receiver.received).toHaveLength(1);
      t.fixture.clock.advance(MINUTE);
      expect(await t.service.sendDue()).toEqual({ sent: 1 });
    });

    // #326-T03
    it("resends after the acknowledgement timeout when the job is still queued, and says which attempt it is on", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();
      expect(t.receiver.received).toHaveLength(1);

      // A Dispatcher claimed it and gave it back (a failed launch): queued again, one attempt lost.
      const claim = await t.fixture.queue.claimNext("dispatcher-a");
      expect(claim?.job.id).toBe(job.id);
      await t.fixture.queue.release(
        job.id,
        claim?.leaseToken ?? "",
        "launch_failed",
      );

      t.fixture.clock.advance(ACK_TIMEOUT_MS - 1);
      expect(await t.service.sendDue()).toEqual({ sent: 0 });
      t.fixture.clock.advance(1);
      expect(await t.service.sendDue()).toEqual({ sent: 1 });
      expect(t.receiver.received.map((c) => c.body?.attempt)).toEqual([1, 2]);
    });

    // #326-T03
    it("does not resend a job that was claimed in time", async () => {
      const t = await setup();
      const { job } = await t.enqueue();
      await t.settled();
      const claim = await t.fixture.queue.claimNext("dispatcher-a");
      expect(claim?.job.id).toBe(job.id);

      t.fixture.clock.advance(10 * MINUTE);
      expect(await t.service.sendDue()).toEqual({ sent: 0 });
      expect(t.receiver.received).toHaveLength(1);
    });

    // #326-T03
    it("resends after the acknowledgement timeout when the job was not claimable", async () => {
      const t = await setup();
      t.receiver.reply(ignored("not_claimable"));

      const { job } = await t.enqueue();
      await t.settled();

      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "pending",
        lastCode: "ignored_not_claimable",
        consecutiveFailures: 0,
        nextDispatchAt: new Date(
          t.fixture.clock.now().getTime() + ACK_TIMEOUT_MS,
        ).toISOString(),
      });
      t.fixture.clock.advance(ACK_TIMEOUT_MS);
      expect(await t.service.sendDue()).toEqual({ sent: 1 });
    });

    // #326-T03
    it("stops resending a job whose kind the receiver cannot run", async () => {
      const t = await setup();
      t.receiver.reply(ignored("not_capable"));

      const { job } = await t.enqueue();
      await t.settled();

      expect(await t.dispatches.get(job.id)).toMatchObject({
        state: "stopped",
        lastCode: "ignored_not_capable",
      });
      t.fixture.clock.advance(24 * 60 * MINUTE);
      expect(await t.service.sendDue()).toEqual({ sent: 0 });
      expect(t.receiver.received).toHaveLength(1);
    });

    // #326-T03
    it("sends a queued job that has no row (its row was never written), once", async () => {
      const t = await setup();
      // Queued by an instance that did not run the hook (or lost it): no row at all.
      const bare = await t.fixture.enqueue();
      expect(bare.status).toBe("created");

      const [first, second] = await Promise.all([
        t.service.sendDue(),
        t.service.sendDue(),
      ]);

      expect(first.sent + second.sent).toBe(1);
      expect(t.receiver.received).toHaveLength(1);
      expect(t.receiver.received[0]?.body?.jobId).toBe(bare.job.id);
      expect(await t.dispatches.get(bare.job.id)).toMatchObject({
        state: "acked",
        attempts: 1,
      });
    });

    // #326-T03
    it("does not send a job another sender claimed after the sweep listed it", async () => {
      const t = await setup();
      const bare = await t.fixture.enqueue();
      const job = {
        jobId: bare.job.id,
        reviewKind: "diff" as const,
        jobAttempts: 0,
      };
      // The first sender is in flight (the endpoint hangs until the limit); the listing the second one works
      // from is older than that claim.
      t.receiver.reply("hang");
      const first = t.service.sendJob(job);
      while (t.receiver.received.length === 0)
        await new Promise((resolve) => setTimeout(resolve, 2));

      expect(await t.service.sendJob(job)).toBe(false);
      await first;

      expect(t.receiver.received).toHaveLength(1);
      expect(await t.dispatches.get(bare.job.id)).toMatchObject({
        attempts: 1,
      });
      // Once the first call is recorded and acknowledged, a stale listing still sends nothing.
      t.receiver.reply();
      expect(await t.service.sendJob(job)).toBe(false);
      expect(t.receiver.received).toHaveLength(1);
    });

    // #326-T03
    it("lets the sweep find due work through the repository's listing of due jobs", async () => {
      const t = await setup();
      const first = await t.fixture.enqueue();
      const second = await t.fixture.enqueue({
        prNumber: 9,
        prUrl: "https://github.test/acme/widgets/pull/9",
      });
      const claim = await t.fixture.queue.claimNext("dispatcher-a");
      const running = claim?.job.id;
      const waiting = running === first.job.id ? second : first;

      const due = await t.dispatches.listDue(t.fixture.clock.now(), 10);

      // The claimed job is running, so only the other one is due.
      expect(due).toEqual([
        { jobId: waiting.job.id, reviewKind: "diff", jobAttempts: 0 },
      ]);
    });
  });

  describe("which enqueues send a call", () => {
    // #326-T09
    it("sends exactly one call per job, for a webhook, a comment and a manual producer", async () => {
      const t = await setup();

      const results = [
        await t.enqueue({
          prNumber: 1,
          prUrl: "https://github.test/acme/widgets/pull/1",
          triggerKind: "webhook",
          deliveryId: "delivery-1",
        }),
        await t.enqueue({
          prNumber: 2,
          prUrl: "https://github.test/acme/widgets/pull/2",
          triggerKind: "comment",
          deliveryId: "delivery-2",
          commentId: "comment-1",
        }),
        await t.enqueue({
          prNumber: 3,
          prUrl: "https://github.test/acme/widgets/pull/3",
          triggerKind: "manual",
        }),
      ];
      await t.settled();

      expect(results.map((result) => result.status)).toEqual([
        "created",
        "created",
        "created",
      ]);
      expect(
        t.receiver.received.map((call) => call.body?.jobId).sort(),
      ).toEqual(results.map((result) => result.job.id).sort());
      expect(await t.rows()).toHaveLength(3);
    });

    // #326-T09
    it("sends nothing for a deduplicated enqueue (same delivery, same head, same comment, same active job)", async () => {
      const t = await setup();
      await t.enqueue({ deliveryId: "delivery-1", headSha: sha("a") });
      await t.enqueue({
        prNumber: 2,
        prUrl: "https://github.test/acme/widgets/pull/2",
        triggerKind: "comment",
        deliveryId: "delivery-2",
        commentId: "comment-1",
      });
      await t.enqueue({
        prNumber: 3,
        prUrl: "https://github.test/acme/widgets/pull/3",
        triggerKind: "manual",
      });
      await t.settled();
      expect(t.receiver.received).toHaveLength(3);

      const replays = await Promise.all([
        t.enqueue({ deliveryId: "delivery-1", headSha: sha("a") }),
        t.enqueue({ deliveryId: "delivery-9", headSha: sha("a") }),
        t.enqueue({
          prNumber: 2,
          prUrl: "https://github.test/acme/widgets/pull/2",
          triggerKind: "comment",
          deliveryId: "delivery-3",
          commentId: "comment-1",
        }),
        t.enqueue({
          prNumber: 3,
          prUrl: "https://github.test/acme/widgets/pull/3",
          triggerKind: "manual",
        }),
      ]);
      await t.settled();

      expect(
        replays.map((r) => (r.status === "existing" ? r.reason : r.status)),
      ).toEqual([
        "same_delivery",
        "same_head",
        "same_comment",
        "already_active",
      ]);
      expect(t.receiver.received).toHaveLength(3);
      expect(await t.rows()).toHaveLength(3);
    });

    // #326-T09
    it("leaves a deduplicated replay to the sweep even when the first call was never recorded", async () => {
      const t = await setup();
      // The first enqueue came from an instance whose hook did not run: the job exists, with no row.
      const first = await t.fixture.enqueue({ deliveryId: "delivery-1" });

      const replay = await t.enqueue({ deliveryId: "delivery-1" });
      await t.settled();

      expect(first.status).toBe("created");
      expect(replay).toMatchObject({
        status: "existing",
        reason: "same_delivery",
      });
      expect(t.receiver.received).toHaveLength(0);
      expect(await t.rows()).toEqual([]);
      // The sweep is what finds it.
      expect(await t.service.sendDue()).toEqual({ sent: 1 });
    });

    // #326-T09
    it("sends a job that is not due yet once it is due, and once only when a person pulls it forward", async () => {
      const t = await setup();
      const runAfter = new Date(t.fixture.clock.now().getTime() + 90 * SECOND);
      const notDue = await t.enqueue({ runAfter });
      const waiting = await t.enqueue({
        prNumber: 2,
        prUrl: "https://github.test/acme/widgets/pull/2",
        runAfter,
      });
      await t.settled();

      // Not due yet: a row waits for its time, and nothing is sent.
      expect(t.receiver.received).toHaveLength(0);
      expect(await t.dispatches.get(notDue.job.id)).toMatchObject({
        state: "pending",
        attempts: 0,
        nextDispatchAt: runAfter.toISOString(),
      });

      // A person starts a review of the first pull request: the waiting job is made due now and is sent now.
      const pulled = await t.enqueue({ triggerKind: "manual" });
      await t.settled();
      expect(pulled).toMatchObject({
        status: "existing",
        reason: "already_active",
      });
      expect(t.receiver.received.map((c) => c.body?.jobId)).toEqual([
        notDue.job.id,
      ]);

      // A second click does not send again.
      await t.enqueue({ triggerKind: "manual" });
      await t.settled();
      expect(t.receiver.received).toHaveLength(1);

      // The other job becomes due by itself: the sweep sends it.
      t.fixture.clock.advance(90 * SECOND);
      expect(await t.service.sendDue()).toEqual({ sent: 1 });
      expect(t.receiver.received.map((c) => c.body?.jobId)).toEqual([
        notDue.job.id,
        waiting.job.id,
      ]);
    });
  });

  describe("what the dispatch logs", () => {
    // #326-T10
    it("never contains a secret, a signature, a key id or the URL, when the send fails in every way", async () => {
      const t = await setup();
      t.receiver.reply(
        { fails: `connect failed to ${URL_OK} with ${CURRENT.secret}` },
        "hang",
        { status: 500, body: CURRENT.secret },
        { status: 429, headers: { "retry-after": "5" }, body: CURRENT.secret },
        { status: 403, body: `${CURRENT.secret} ${PREVIOUS.secret}` },
      );

      for (let number = 1; number <= 5; number += 1)
        await t.enqueue({
          prNumber: number,
          prUrl: `https://github.test/acme/widgets/pull/${String(number)}`,
        });
      await t.settled();

      const lines = [...t.logs.warn, ...t.logs.error];
      expect(lines.length).toBeGreaterThanOrEqual(5);
      const signatures = t.receiver.received.map(
        (call) => call.headers["x-dispatch-signature"] ?? "",
      );
      expect(signatures.every((signature) => signature.startsWith("v1="))).toBe(
        true,
      );
      const text = lines.join("\n");
      for (const forbidden of [
        CURRENT.secret,
        PREVIOUS.secret,
        "dispatcher.example.test",
        CURRENT.kid,
        ...signatures,
        ...signatures.map((signature) => signature.slice(3)),
      ])
        expect(text).not.toContain(forbidden);
      expect(text).toContain("code=network_error");
      expect(text).toContain("code=timeout");
      expect(text).toContain("code=server_error");
      expect(text).toContain("code=rate_limited");
      expect(text).toContain("code=rejected");
    });
  });
});
