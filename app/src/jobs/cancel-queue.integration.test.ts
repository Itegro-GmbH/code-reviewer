// SPDX-License-Identifier: LicenseRef-Proprietary

// A member cancels a turn of the Implementer (#891): a waiting turn ends at once; a running one is marked, its holder learns it from the
// heartbeat, and the job ends `cancelled` with what the holder reports, with a lapsed lease, with a claim given back, or when the grace for the
// stop is over. Billing charges only what the turn used.
import { describe, expect, it } from "vitest";
import { createCapabilitySet } from "../capabilities/capability.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import { heartbeatAnswer } from "../runner-api/report.ts";
import { createJobQueue } from "./job-queue.ts";
import type { EnqueueImplementerTurnInput } from "./job-types.ts";

const MINUTE = 60 * 1000;
const IMPLEMENTER = ["implementer"] as const;

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

const USAGE = {
  model: "m",
  promptTokens: 600,
  completionTokens: 150,
  totalTokens: 750,
  aiCalls: 1,
  fallbackUsed: false,
  costUsd: 0.0042,
};
const CANCELLED_RESULT = {
  ok: false,
  durationMs: 5,
  commentUrl: null,
  errorCode: "cancelled",
  logTail: "cancelled",
  logTruncated: false,
  usage: USAGE,
};

async function start() {
  const unknown: string[] = [];
  const fixture = await createJobQueueFixture({
    database: await open(),
    onUnknownCostSettled: (settlement) => unknown.push(settlement.jobId),
  });
  await addUser(fixture.db, "user-1");
  const capable = createCapabilitySet(["review", "implementer"]);
  const queue = createJobQueue(fixture.db, fixture.workspaceId, {
    now: fixture.clock.now,
    kindAllowed: (kind) => capable.allowsReviewKind(kind),
  });
  let counter = 0;
  async function turn(overrides: Partial<EnqueueImplementerTurnInput> = {}) {
    counter += 1;
    fixture.clock.advance(1);
    const result = await queue.enqueueImplementerTurn({
      repositoryId: fixture.repositoryId,
      baseBranch: "main",
      baseSha: sha("b"),
      branch: `implementer/c${String(counter)}`,
      instruction: "Add a health endpoint.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: `request-${String(counter)}`,
      ...overrides,
    });
    if (result.status !== "created")
      throw new Error(`expected a new turn, got ${result.status}`);
    return result;
  }
  /** A turn that a runner holds. */
  async function running() {
    const created = await turn();
    const claimed = await fixture.queue.claimNext("r", IMPLEMENTER, {
      jobId: created.job.id,
    });
    if (claimed === null) throw new Error("the turn was not claimed");
    return { ...created, leaseToken: claimed.leaseToken };
  }
  const sessionOf = (id: string) =>
    createImplementerRepository(fixture.db, fixture.workspaceId).getSession(id);
  const record = (jobId: string) =>
    fixture.db
      .selectFrom("usage_records")
      .selectAll()
      .where("job_id", "=", jobId)
      .executeTakeFirstOrThrow();
  return { fixture, queue, turn, running, sessionOf, record, unknown };
}

describe("cancelling a turn of the Implementer", () => {
  // #891-T01
  it("ends a waiting turn at once: code cancelled, its record void, its session idle", async () => {
    const t = await start();
    const { job, session } = await t.turn();

    const result = await t.queue.requestCancel(job.id);

    expect(result.status).toBe("cancelled");
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled",
      finishedAt: t.fixture.clock.now().toISOString(),
    });
    expect((await t.sessionOf(session.id))?.status).toBe("idle");
    // Nobody can claim it any more.
    expect(await t.fixture.queue.claimNext("r", IMPLEMENTER)).toBeNull();
  });

  // #891-T02
  it("marks a running turn and keeps it running; asking again is a no-op that says so", async () => {
    const t = await start();
    const { job, leaseToken } = await t.running();

    const asked = t.fixture.clock.now().toISOString();
    const first = await t.queue.requestCancel(job.id);
    t.fixture.clock.advance(MINUTE);
    const second = await t.queue.requestCancel(job.id);

    expect(first.status).toBe("requested");
    expect(first.status === "requested" && first.job.cancelRequestedAt).toBe(
      asked,
    );
    expect(second.status).toBe("already_requested");
    // The first moment stays.
    expect(
      second.status === "already_requested" && second.job.cancelRequestedAt,
    ).toBe(asked);
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "running",
    });
    // The heartbeat extends the lease and tells the holder.
    const beat = await t.fixture.queue.heartbeat(job.id, leaseToken);
    expect(beat.status).toBe("ok");
    if (beat.status !== "ok") return;
    expect(heartbeatAnswer(beat.job, false).job.cancelRequested).toBe(true);
  });

  // #891-T03
  it("says so for a job that is over and for one that does not exist or belongs to another workspace", async () => {
    const t = await start();
    const { job, leaseToken } = await t.running();
    await t.fixture.queue.complete(job.id, leaseToken, {
      ok: true,
      result: {},
    });

    expect((await t.queue.requestCancel(job.id)).status).toBe("already_ended");
    expect((await t.queue.requestCancel("no-such-job")).status).toBe(
      "not_found",
    );
    const other = createJobQueue(t.fixture.db, "other-workspace", {
      now: t.fixture.clock.now,
    });
    expect((await other.requestCancel(job.id)).status).toBe("not_found");
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "succeeded",
      cancelRequestedAt: null,
    });
  });

  // #891-T04
  it("ends the job cancelled with what its holder reports, and settles its record with the cost it measured", async () => {
    const t = await start();
    const { job, session, leaseToken } = await t.running();
    await t.queue.requestCancel(job.id);

    const completed = await t.fixture.queue.complete(job.id, leaseToken, {
      ok: false,
      errorCode: "cancelled",
      result: CANCELLED_RESULT,
    });

    expect(completed.status).toBe("completed");
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled",
      leaseExpiresAt: null,
    });
    expect((await t.sessionOf(session.id))?.status).toBe("idle");
    expect(await t.record(job.id)).toMatchObject({
      state: "settled",
      cost_micro_usd: 4200,
      review_kind: "implementer",
    });
    // The same report again is recognised; another outcome is a conflict.
    expect(
      (
        await t.fixture.queue.complete(job.id, leaseToken, {
          ok: false,
          errorCode: "cancelled",
          result: CANCELLED_RESULT,
        })
      ).status,
    ).toBe("already_completed");
    expect(
      (
        await t.fixture.queue.complete(job.id, leaseToken, {
          ok: true,
          result: {},
        })
      ).status,
    ).toBe("outcome_conflict");
  });

  // #891-T05
  it("charges a cancelled turn what it used and nothing else, with billing on", async () => {
    const t = await start();
    await setBillingSwitch(t.fixture.db, true);
    await fundWorkspace(t.fixture.db, t.fixture.workspaceId, 1_000_000);
    const { job, leaseToken } = await t.running();
    t.fixture.clock.advance(2 * MINUTE);
    await t.queue.requestCancel(job.id);

    await t.fixture.queue.complete(job.id, leaseToken, {
      ok: false,
      errorCode: "cancelled",
      result: CANCELLED_RESULT,
    });

    const usage = await t.fixture.db
      .selectFrom("billing_journal_entries")
      .selectAll()
      .where("type", "=", "usage")
      .execute();
    // One charge for the settled run (the model cost it reported and its minutes), and its billing is closed.
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ review_kind: "implementer" });
    expect((await t.record(job.id)).billing_state).not.toBe("open");
  });

  // #891-T06
  it("ends a turn cancelled, not failed or queued again, when its lease lapses after the request", async () => {
    const t = await start();
    const { job } = await t.running();
    await t.queue.requestCancel(job.id);

    t.fixture.clock.advance(3 * MINUTE);
    await t.fixture.queue.expireStaleJobs();

    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled",
    });
  });

  // #891-T07
  it("ends a turn its runner gives back cancelled, and does not queue it again", async () => {
    const t = await start();
    const { job, leaseToken } = await t.running();
    await t.queue.requestCancel(job.id);

    const released = await t.fixture.queue.release(
      job.id,
      leaseToken,
      "runner_shutdown",
    );

    expect(released.status).toBe("cancelled");
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled",
    });
    expect(await t.fixture.queue.claimNext("r2", IMPLEMENTER)).toBeNull();
  });

  // #891-T17
  it("ends a turn whose Worker could not be started cancelled but free: a void record, no charge, never a no_result", async () => {
    const t = await start();
    await setBillingSwitch(t.fixture.db, true);
    await fundWorkspace(t.fixture.db, t.fixture.workspaceId, 1_000_000);
    const { job, leaseToken } = await t.running();
    t.fixture.clock.advance(2 * MINUTE);
    await t.queue.requestCancel(job.id);

    const released = await t.fixture.queue.release(
      job.id,
      leaseToken,
      "launch_failed",
      { beforeStart: true },
    );

    // A failure of the platform is ours whoever asked for the stop: the job ends cancelled, never queued again, with the reason.
    expect(released.status).toBe("cancelled");
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "launch_failed",
    });
    expect(await t.record(job.id)).toMatchObject({ state: "void" });
    expect((await t.record(job.id)).settled_reason).toBeNull();
    expect(t.unknown).not.toContain(job.id);
    const usage = await t.fixture.db
      .selectFrom("billing_journal_entries")
      .selectAll()
      .where("type", "=", "usage")
      .execute();
    expect(usage).toHaveLength(0);
    expect(await t.fixture.queue.claimNext("r2", IMPLEMENTER)).toBeNull();
  });

  // #891-T08
  it("ends a turn that did not stop within the grace, at the sweep and at the next heartbeat, and settles its record with an unknown cost", async () => {
    const t = await start();
    const first = await t.running();
    await t.queue.requestCancel(first.job.id);

    // Inside the grace nothing changes, however the lease is kept.
    t.fixture.clock.advance(MINUTE);
    await t.fixture.queue.heartbeat(first.job.id, first.leaseToken);
    t.fixture.clock.advance(MINUTE);
    await t.fixture.queue.expireStaleJobs();
    expect((await t.fixture.queue.get(first.job.id))?.status).toBe("running");

    // Past it, the heartbeat of a holder that kept its lease ends the job: it is told it lost the claim.
    t.fixture.clock.advance(3 * MINUTE);
    const beat = await t.fixture.queue.heartbeat(
      first.job.id,
      first.leaseToken,
    );
    expect(beat.status).toBe("not_holder");
    expect(await t.fixture.queue.get(first.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled",
    });
    expect(await t.record(first.job.id)).toMatchObject({
      state: "settled",
      settled_reason: "no_result",
      cost_micro_usd: null,
    });
    expect(t.unknown).toContain(first.job.id);

    // And the sweep does it for a holder that stopped beating altogether, with a lease that has not lapsed yet.
    const second = await t.running();
    await t.queue.requestCancel(second.job.id);
    t.fixture.clock.advance(5 * MINUTE);
    await t.fixture.queue.expireStaleJobs();
    expect((await t.fixture.queue.get(second.job.id))?.status).toBe(
      "cancelled",
    );
  });
});
