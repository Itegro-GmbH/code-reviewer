// SPDX-License-Identifier: LicenseRef-Proprietary

// A turn of the Implementer travels through the one job queue (#752, part of #745): one `jobs` row of the kind `implementer`
// with placeholders where a pull request would be (`db/implementer-job-shape.ts`), claimed only by a runner with the engine
// `implementer`, never retried, held to its own time limit, and invisible to everything that acts on pull requests. A project
// never selects the kind (T06 is in `job-kind.test.ts`).
import { describe, expect, it } from "vitest";
import { createCapabilitySet } from "../capabilities/capability.ts";
import type { JobQueueLimits } from "../db/job-limits.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import type { ClaimRefusal } from "../db/repositories/claim-admission.ts";
import {
  TEST_BILLING_RATES,
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import {
  createJobQueueFixture,
  sha,
  type JobQueueFixture,
} from "../test-support/jobs.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { seedImplementerRepository } from "../test-support/implementer.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import type { EntitlementsData } from "../workspaces/entitlements.ts";
import { createJobQueue, type JobQueue } from "./job-queue.ts";
import { JobQueueError } from "./errors.ts";
import type { EnqueueImplementerTurnInput } from "./job-types.ts";

const MINUTE = 60 * 1000;
const IMPLEMENTER = ["implementer"] as const;
const DIFF_AND_DYNAMIC = ["pr-agent", "opencode"] as const;

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

async function start(
  options: {
    dynamicReview?: boolean;
    limits?: Partial<JobQueueLimits>;
    onRefused?: (refusal: ClaimRefusal) => void;
  } = {},
) {
  const fixture = await createJobQueueFixture({
    database: await open(),
    ...(options.dynamicReview === true ? { dynamicReview: true } : {}),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.onRefused === undefined
      ? {}
      : { onRefused: options.onRefused }),
  });
  await addUser(fixture.db, "user-1");
  const capable = createCapabilitySet([
    "review",
    "dynamic-review",
    "implementer",
  ]);
  const queue: JobQueue = createJobQueue(fixture.db, fixture.workspaceId, {
    now: fixture.clock.now,
    kindAllowed: (kind) => capable.allowsReviewKind(kind),
  });
  let counter = 0;
  const input = (
    overrides: Partial<EnqueueImplementerTurnInput> = {},
  ): EnqueueImplementerTurnInput => {
    counter += 1;
    return {
      repositoryId: fixture.repositoryId,
      baseBranch: "main",
      baseSha: sha("b"),
      branch: `implementer/b${String(counter)}`,
      instruction: "Add a health endpoint.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: `request-${String(counter)}`,
      ...overrides,
    };
  };
  async function turn(overrides: Partial<EnqueueImplementerTurnInput> = {}) {
    // Jobs are claimed oldest first by their creation time; the clock is the test's, so every enqueue gets its own millisecond.
    fixture.clock.advance(1);
    const result = await queue.enqueueImplementerTurn(input(overrides));
    if (result.status !== "created")
      throw new Error(`expected a new turn, got ${result.status}`);
    return result;
  }
  const counts = async () => {
    const count = async (
      table: "jobs" | "implementer_sessions" | "implementer_turns",
    ) =>
      Number(
        (
          await fixture.db
            .selectFrom(table)
            .select((eb) => eb.fn.countAll().as("n"))
            .executeTakeFirstOrThrow()
        ).n,
      );
    return {
      jobs: await count("jobs"),
      sessions: await count("implementer_sessions"),
      turns: await count("implementer_turns"),
    };
  };
  const sessionOf = (id: string) =>
    createImplementerRepository(fixture.db, fixture.workspaceId).getSession(id);
  return { fixture, queue, input, turn, counts, sessionOf };
}

/** A second turn of a session as a later change will make it: another job on the session's negative number. */
async function insertFollowUpJob(
  fixture: JobQueueFixture,
  first: { id: string; prNumber: number },
) {
  const job = await fixture.db
    .selectFrom("jobs")
    .selectAll()
    .where("id", "=", first.id)
    .executeTakeFirstOrThrow();
  const id = crypto.randomUUID();
  await fixture.db
    .insertInto("jobs")
    .values({
      ...job,
      id,
      delivery_id: `implementer:follow-up:${id}`,
      status: "queued",
      attempts: 0,
      runner_id: null,
      lease_token: null,
      claimed_at: null,
      heartbeat_at: null,
      lease_expires_at: null,
      finished_at: null,
      error_code: null,
      result: null,
      created_at: new Date(fixture.clock.now().getTime() + 1).toISOString(),
    })
    .execute();
  return id;
}

describe("enqueueing a turn of the Implementer", () => {
  // #752-T01
  it("writes the session, the turn and a queued job with the documented placeholders", async () => {
    const t = await start();

    const result = await t.turn({
      branch: "implementer/abc123",
      baseSha: sha("c"),
      clientRequestId: "req-1",
      costLimitCents: 500,
    });

    expect(result.job).toMatchObject({
      reviewKind: "implementer",
      triggerKind: "manual",
      actorLogin: "octocat",
      prNumber: -1,
      prUrl: "https://github.test/acme/gadgets/tree/implementer/abc123",
      headSha: sha("c"),
      command: "review",
      args: "",
      deliveryId: `implementer:${t.fixture.workspaceId}:req-1`,
      status: "queued",
      attempts: 0,
    });
    expect(result.session).toMatchObject({
      slot: 1,
      branch: "implementer/abc123",
      baseBranch: "main",
      status: "running",
      createdBy: "user-1",
    });
    expect(result.turn).toMatchObject({
      number: 1,
      jobId: result.job.id,
      sessionId: result.session.id,
      costLimitCents: 500,
      modelChoice: { entryId: "entry-1" },
    });
    expect(await t.counts()).toEqual({ jobs: 1, sessions: 1, turns: 1 });
  });

  // #752-T01
  it("returns the existing turn for the same clientRequestId and writes nothing new, whatever else the request says", async () => {
    const t = await start();
    const first = await t.turn({ clientRequestId: "req-1" });

    // The branch is taken now: without the lookup this would be `IMPLEMENTER_JOB_MISMATCH`/`IMPLEMENTER_BRANCH_TAKEN`.
    const again = await t.queue.enqueueImplementerTurn(
      t.input({ clientRequestId: "req-1", branch: first.session.branch }),
    );
    const other = await t.queue.enqueueImplementerTurn(
      t.input({ clientRequestId: "req-1", branch: "implementer/other" }),
    );

    for (const repeated of [again, other]) {
      expect(repeated.status).toBe("existing");
      expect(repeated.job.id).toBe(first.job.id);
      expect(repeated.session.id).toBe(first.session.id);
      expect(repeated.turn.id).toBe(first.turn.id);
    }
    expect(await t.counts()).toEqual({ jobs: 1, sessions: 1, turns: 1 });
  });

  // #752-T01
  it("lets two requests with one clientRequestId race: one turn is made, both answers name it", async () => {
    const t = await start();
    const request = t.input({ clientRequestId: "req-race" });

    const results = await Promise.all([
      t.queue.enqueueImplementerTurn(request),
      t.queue.enqueueImplementerTurn(request),
      t.queue.enqueueImplementerTurn(request),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "created",
      "existing",
      "existing",
    ]);
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    expect(await t.counts()).toEqual({ jobs: 1, sessions: 1, turns: 1 });
  });

  // #752-T01
  it("keeps the clientRequestId of one workspace apart from the same one in another", async () => {
    const t = await start();
    const mine = await t.turn({ clientRequestId: "shared" });
    const otherId = await addWorkspace(t.fixture.db, "other");
    const other = await seedImplementerRepository(t.fixture.db, otherId, "o");
    const otherQueue = createJobQueue(t.fixture.db, otherId, {
      now: t.fixture.clock.now,
    });

    const theirs = await otherQueue.enqueueImplementerTurn(
      t.input({
        clientRequestId: "shared",
        repositoryId: other.repositoryId,
        createdBy: other.userId,
      }),
    );

    expect(theirs.status).toBe("created");
    expect(theirs.job.id).not.toBe(mine.job.id);
    expect(theirs.job.deliveryId).toBe(`implementer:${otherId}:shared`);
    expect(mine.job.deliveryId).toBe(
      `implementer:${t.fixture.workspaceId}:shared`,
    );
  });

  // #752-T01
  it("refuses a branch that already has a session with IMPLEMENTER_BRANCH_TAKEN for a new request", async () => {
    const t = await start();
    await t.turn({ branch: "implementer/same" });

    await expect(
      t.queue.enqueueImplementerTurn(
        t.input({ branch: "implementer/same", clientRequestId: "new" }),
      ),
    ).rejects.toMatchObject({ code: "IMPLEMENTER_BRANCH_TAKEN" });
    expect(await t.counts()).toEqual({ jobs: 1, sessions: 1, turns: 1 });
  });

  // #752-T01
  it.each([
    ["an empty clientRequestId", { clientRequestId: "" }],
    ["an overlong clientRequestId", { clientRequestId: "x".repeat(201) }],
    ["a clientRequestId with a line break", { clientRequestId: "a\nb" }],
    ["an empty branch", { branch: "" }],
    ["a base commit that is not a sha", { baseSha: "main" }],
    ["an empty actor", { actorLogin: "" }],
  ])(
    "refuses %s with JOB_INPUT_INVALID and writes nothing",
    async (_name, overrides) => {
      const t = await start();

      const error = await t.queue
        .enqueueImplementerTurn(t.input(overrides))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(JobQueueError);
      expect(error).toMatchObject({ code: "JOB_INPUT_INVALID" });
      expect(await t.counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
    },
  );

  // #752-T02
  it("refuses with JOB_KIND_UNAVAILABLE without the capability and writes no row in any of the three tables", async () => {
    const t = await start();
    const without = createCapabilitySet(["review", "dynamic-review"]);
    const queue = createJobQueue(t.fixture.db, t.fixture.workspaceId, {
      now: t.fixture.clock.now,
      kindAllowed: (kind) => without.allowsReviewKind(kind),
    });

    await expect(queue.enqueueImplementerTurn(t.input())).rejects.toMatchObject(
      {
        name: "JobQueueError",
        code: "JOB_KIND_UNAVAILABLE",
      },
    );

    expect(await t.counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #752-T02
  it("refuses an unknown repository with JOB_REPOSITORY_UNKNOWN and writes nothing", async () => {
    const t = await start();

    await expect(
      t.queue.enqueueImplementerTurn(t.input({ repositoryId: "nope" })),
    ).rejects.toMatchObject({ code: "JOB_REPOSITORY_UNKNOWN" });

    expect(await t.counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #752-T11
  it("is not blocked by the Dynamic gate being off: the turn is queued, not failed", async () => {
    const t = await start({ dynamicReview: false });

    const { job } = await t.turn();

    expect(job).toMatchObject({ status: "queued", errorCode: null });
  });

  // #752-T11
  it("is not touched when the Dynamic gate is switched off, which cancels waiting Dynamic jobs", async () => {
    const t = await start({ dynamicReview: true });
    const { job } = await t.turn();
    const dynamic = await t.fixture.enqueueNew({
      prNumber: 9,
      reviewKind: "dynamic",
    });

    await createInstanceSettingsRepository(
      t.fixture.db,
      t.fixture.clock.now,
    ).set("dynamic_review", { enabled: false }, null);
    await t.fixture.queue.expireStaleJobs();

    expect(await t.fixture.queue.get(dynamic.id)).toMatchObject({
      status: "cancelled",
      errorCode: "dynamic_review_disabled",
    });
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "queued",
      errorCode: null,
    });
    expect((await t.fixture.queue.claimNext("r", IMPLEMENTER))?.job.id).toBe(
      job.id,
    );
  });
});

describe("claiming a turn", () => {
  // #752-T04
  it("is done only by a runner with the engine implementer, which counts no attempt for the others", async () => {
    const t = await start({ dynamicReview: true });
    const { job } = await t.turn();

    expect(
      await t.fixture.queue.claimNext("diff-runner", ["pr-agent"]),
    ).toBeNull();
    expect(
      await t.fixture.queue.claimNext("dynamic-runner", DIFF_AND_DYNAMIC),
    ).toBeNull();
    expect(await t.fixture.queue.claimNext("legacy-runner")).toBeNull();
    const untouched = await t.fixture.db
      .selectFrom("jobs")
      .select(["status", "attempts", "runner_id", "lease_token"])
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    expect(untouched).toEqual({
      status: "queued",
      attempts: 0,
      runner_id: null,
      lease_token: null,
    });

    const claimed = await t.fixture.queue.claimNext("implementer-runner", [
      "implementer",
    ]);
    expect(claimed?.job).toMatchObject({
      id: job.id,
      status: "running",
      reviewKind: "implementer",
    });
  });

  // #752-T04
  it("leaves Diff and Dynamic jobs to their own runners, and the implementer engine takes nothing but turns", async () => {
    const t = await start({ dynamicReview: true });
    const diff = await t.fixture.enqueueNew({ prNumber: 1 });
    t.fixture.clock.advance(1);
    const dynamic = await t.fixture.enqueueNew({
      prNumber: 2,
      reviewKind: "dynamic",
    });
    const { job } = await t.turn();

    expect((await t.fixture.queue.claimNext("i", IMPLEMENTER))?.job.id).toBe(
      job.id,
    );
    expect(await t.fixture.queue.claimNext("i", IMPLEMENTER)).toBeNull();
    expect(
      (await t.fixture.queue.claimNext("d", DIFF_AND_DYNAMIC))?.job.id,
    ).toBe(diff.id);
    expect(
      (await t.fixture.queue.claimNext("d", DIFF_AND_DYNAMIC))?.job.id,
    ).toBe(dynamic.id);
  });

  // #752-T03
  it("never runs two turns of one session at once, and runs two sessions of one repository in parallel", async () => {
    const t = await start();
    const first = await t.turn();
    const secondTurnId = await insertFollowUpJob(t.fixture, first.job);
    const otherSession = await t.turn();

    const a = await t.fixture.queue.claimNext("r1", IMPLEMENTER);
    const b = await t.fixture.queue.claimNext("r2", IMPLEMENTER);
    const c = await t.fixture.queue.claimNext("r3", IMPLEMENTER);

    // The first session's first turn and the other session's turn run; the follow-up waits behind the first.
    expect([a?.job.id, b?.job.id].sort()).toEqual(
      [first.job.id, otherSession.job.id].sort(),
    );
    expect(c).toBeNull();
    expect(await t.fixture.queue.get(secondTurnId)).toMatchObject({
      status: "queued",
      attempts: 0,
    });
    expect(otherSession.job.prNumber).toBe(-2);

    await t.fixture.queue.complete(
      first.job.id,
      await t.fixture.tokenOf(first.job.id),
      { ok: true, result: {} },
    );
    expect((await t.fixture.queue.claimNext("r3", IMPLEMENTER))?.job.id).toBe(
      secondTurnId,
    );
  });

  // #752-T12
  it("reserves a usage record at claim like for any job, billing off", async () => {
    const t = await start();
    const { job } = await t.turn();

    await t.fixture.queue.claimNext("r", IMPLEMENTER);

    expect(
      await t.fixture.db.selectFrom("usage_records").selectAll().execute(),
    ).toEqual([
      expect.objectContaining({
        job_id: job.id,
        review_kind: "implementer",
        state: "reserved",
        key_mode: "own",
      }),
    ]);
  });

  // #752-T12
  it("reserves a usage record at claim with billing on, priced as Dynamic, and opens its billing", async () => {
    const t = await start();
    await setBillingSwitch(t.fixture.db, true);
    await fundWorkspace(t.fixture.db, t.fixture.workspaceId, 1_000_000);
    const { job } = await t.turn();

    const claimed = await t.fixture.queue.claimNext("r", IMPLEMENTER);

    expect(claimed?.job.id).toBe(job.id);
    expect(
      await t.fixture.db.selectFrom("usage_records").selectAll().execute(),
    ).toEqual([
      expect.objectContaining({
        job_id: job.id,
        review_kind: "implementer",
        state: "reserved",
        billing_state: "open",
      }),
    ]);

    // Ended: the settlement prices the turn with the Dynamic rate and writes no entry of a kind the journal does not know.
    t.fixture.clock.advance(3 * MINUTE);
    const completed = await t.fixture.queue.complete(
      job.id,
      claimed!.leaseToken,
      { ok: true, result: {} },
    );
    expect(completed.status).toBe("completed");
    const kinds = (
      await t.fixture.db
        .selectFrom("billing_journal_entries")
        .select("review_kind")
        .where("type", "in", ["usage", "reservation", "release"])
        .execute()
    ).map((row) => row.review_kind);
    for (const kind of kinds) expect([null, "implementer"]).toContain(kind);
    expect(TEST_BILLING_RATES.minuteRateMicroUsd.dynamic).toBeGreaterThan(0);
  });

  // #752-T12
  it("counts the runs of a turn with the Dynamic runs of the plan", async () => {
    const t = await start();
    await createWorkspaceEntitlementsRepository(
      t.fixture.db,
      t.fixture.workspaceId,
      t.fixture.clock.now,
    ).put(entitlements({ dynamicRunsPerPeriod: 1 }), null);
    const first = await t.turn();
    const second = await t.turn();

    expect((await t.fixture.queue.claimNext("r", IMPLEMENTER))?.job.id).toBe(
      first.job.id,
    );
    expect(await t.fixture.queue.claimNext("r", IMPLEMENTER)).toBeNull();

    expect(await t.fixture.queue.get(second.job.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
  });
});

function entitlements(
  limits: Partial<EntitlementsData["limits"]> = {},
  overrides: Partial<EntitlementsData> = {},
): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode: "own",
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
      ...limits,
    },
    ...overrides,
  };
}

describe("what acts on pull requests leaves a turn alone", () => {
  // #752-T05
  it("is not cancelled, superseded or discarded by a closed pull request, a push, a draft, a deactivated project or a changed review kind", async () => {
    const t = await start({ dynamicReview: true });
    const { job } = await t.turn();
    const second = await t.turn();
    // Pull requests 1 to 3 of the same repository: a waiting automatic job each, the way the webhooks queue them.
    const requests = [1, 2, 3];
    for (const prNumber of requests)
      await t.fixture.enqueueNew({ prNumber, headSha: sha("a") });

    // A push replaces the waiting automatic job of the pull request and never a turn.
    for (const prNumber of requests)
      await t.fixture.enqueue({ prNumber, headSha: sha("d") });
    for (const prNumber of requests)
      await t.fixture.queue.discardWaitingAutomaticForPr(
        t.fixture.repositoryId,
        prNumber,
      );
    for (const prNumber of requests)
      await t.fixture.queue.discardWaitingForPr(
        t.fixture.repositoryId,
        prNumber,
      );
    await t.fixture.queue.cancelWaitingForReviewKindChange(
      t.fixture.repositoryId,
    );
    await t.fixture.queue.cancelWaitingForRepository(t.fixture.repositoryId);

    for (const id of [job.id, second.job.id])
      expect(await t.fixture.queue.get(id)).toMatchObject({
        status: "queued",
        errorCode: null,
        supersededBy: null,
      });
    // The pull request jobs were affected (the control), so the calls did something.
    expect(
      await t.fixture.queue.list({ status: ["cancelled", "superseded"] }),
    ).not.toHaveLength(0);
  });

  // #752-T05
  it("is not cancelled by the settings hook of a project whose review kind changed", async () => {
    const t = await start();
    const { job } = await t.turn();

    const cancelled = await t.fixture.queue.cancelWaitingForReviewKindChange(
      t.fixture.repositoryId,
    );

    expect(cancelled).toBe(0);
    expect((await t.fixture.queue.get(job.id))?.status).toBe("queued");
  });

  // #752-T05
  it("is not given to the history lookups of a review: no previous reviewed head, no attempted heads", async () => {
    const t = await start();
    const { job } = await t.turn();
    const { createJobsRepository } =
      await import("../db/repositories/jobs-repository.ts");
    const jobs = createJobsRepository(t.fixture.db, t.fixture.workspaceId);
    await t.fixture.queue.claimNext("r", IMPLEMENTER);
    await t.fixture.queue.release(
      job.id,
      await t.fixture.tokenOf(job.id),
      "runner_shutdown",
    );
    const input = {
      repositoryId: t.fixture.repositoryId,
      prNumber: job.prNumber,
      reviewKind: "implementer" as const,
      excludeJobId: "other",
    };

    expect(await jobs.previousReviewedSha(input)).toBeNull();
    expect(await jobs.attemptedShas(input)).toEqual({
      shas: [],
      truncated: false,
    });
  });
});

describe("the end of a turn without a report", () => {
  // #752-T07
  it("fails an implementer job whose lease ran out, at the first attempt, and requeues a Diff job", async () => {
    const t = await start();
    const { job, session } = await t.turn();
    const diff = await t.fixture.enqueueNew({ prNumber: 5 });
    await t.fixture.queue.claimNext("r", IMPLEMENTER);
    await t.fixture.queue.claimNext("d", ["pr-agent"]);

    t.fixture.clock.advance(3 * MINUTE);
    const report = await t.fixture.queue.expireStaleJobs();

    expect(report).toMatchObject({ requeued: 1, leaseExpired: 1 });
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
      attempts: 1,
    });
    expect(await t.fixture.queue.get(diff.id)).toMatchObject({
      status: "queued",
      attempts: 1,
    });
    // #771 finding: the session is idle again, otherwise it stays running for good.
    expect(await t.sessionOf(session.id)).toMatchObject({ status: "idle" });
  });

  // #752-T07
  it.each(["runner_shutdown", "token_unavailable"])(
    "fails an implementer job a runner gives back for %s instead of requeueing it, and a Diff job is requeued",
    async (reason) => {
      const t = await start();
      const { job, session } = await t.turn();
      const diff = await t.fixture.enqueueNew({ prNumber: 5 });
      const turnClaim = await t.fixture.queue.claimNext("r", IMPLEMENTER);
      const diffClaim = await t.fixture.queue.claimNext("d", ["pr-agent"]);

      const released = await t.fixture.queue.release(
        job.id,
        turnClaim!.leaseToken,
        reason,
      );
      const diffReleased = await t.fixture.queue.release(
        diff.id,
        diffClaim!.leaseToken,
        reason,
      );

      expect(released).toMatchObject({
        status: "failed",
        job: { errorCode: reason, attempts: 1 },
      });
      expect(diffReleased.status).toBe("requeued");
      expect(await t.sessionOf(session.id)).toMatchObject({ status: "idle" });
    },
  );

  // #753-T06: the input never reached a Worker, so nothing ran and nothing was pushed.
  it("requeues an implementer job given back before its input left, with the general cap, and still fails it at the cap", async () => {
    const t = await start();
    const { job, session } = await t.turn();

    const first = await t.fixture.queue.claimNext("r", IMPLEMENTER);
    const released = await t.fixture.queue.release(
      job.id,
      first!.leaseToken,
      "git_access_unavailable",
      { beforeStart: true },
    );

    expect(released).toMatchObject({
      status: "requeued",
      job: { status: "queued", attempts: 1 },
    });
    expect(await t.sessionOf(session.id)).toMatchObject({ status: "running" });

    // The general cap of attempts still ends it: it is not retried for ever.
    let last = released;
    for (
      let attempt = 0;
      attempt < 5 && last.status === "requeued";
      attempt += 1
    ) {
      const again = await t.fixture.queue.claimNext("r", IMPLEMENTER);
      last = await t.fixture.queue.release(
        job.id,
        again!.leaseToken,
        "git_access_unavailable",
        { beforeStart: true },
      );
    }
    expect(last).toMatchObject({
      status: "failed",
      job: { errorCode: "git_access_unavailable" },
    });
    expect(await t.sessionOf(session.id)).toMatchObject({ status: "idle" });
  });

  // #752-T07: a turn that ends with a failure report and no `recordTurnResult` (the runner failed before it had a result).
  it("sets the session idle when the runner reports a failure, which records no turn result", async () => {
    const t = await start();
    const { job, session } = await t.turn();
    const claimed = await t.fixture.queue.claimNext("r", IMPLEMENTER);
    expect(await t.sessionOf(session.id)).toMatchObject({ status: "running" });

    const completed = await t.fixture.queue.complete(
      job.id,
      claimed!.leaseToken,
      { ok: false, errorCode: "checkout_incomplete" },
    );

    expect(completed.status).toBe("completed");
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "checkout_incomplete",
    });
    expect(await t.sessionOf(session.id)).toMatchObject({ status: "idle" });
  });

  // #752-T07
  it("keeps the session running while its turn runs, and leaves a turn that reported to the report", async () => {
    const t = await start();
    const { job, session } = await t.turn();
    const claimed = await t.fixture.queue.claimNext("r", IMPLEMENTER);

    expect(await t.sessionOf(session.id)).toMatchObject({ status: "running" });
    await t.fixture.queue.heartbeat(job.id, claimed!.leaseToken);
    expect(await t.sessionOf(session.id)).toMatchObject({ status: "running" });
  });

  // #752-T07
  it("sets the session idle when its holder cancels the turn", async () => {
    const t = await start();
    const { job, session } = await t.turn();
    const claimed = await t.fixture.queue.claimNext("r", IMPLEMENTER);

    const result = await t.fixture.queue.cancelClaimed(
      job.id,
      claimed!.leaseToken,
      "project_deactivated",
    );

    expect(result.status).toBe("cancelled");
    expect(await t.sessionOf(session.id)).toMatchObject({ status: "idle" });
  });

  // #752-T07
  it("sets the session idle when no Dispatcher took the turn", async () => {
    const t = await start();
    const { job, session } = await t.turn();

    t.fixture.clock.advance(11 * MINUTE);
    await t.fixture.queue.failUndispatched(5 * MINUTE);

    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "dispatch_unavailable",
    });
    expect(await t.sessionOf(session.id)).toMatchObject({ status: "idle" });
  });

  // #752-T04
  it("cancels a turn no runner with the engine claims within the deadline, with no_capable_runner and no attempt", async () => {
    const t = await start({ limits: { noCapableRunnerMs: 10 * MINUTE } });
    const { job, session } = await t.turn();
    const diff = await t.fixture.enqueueNew({ prNumber: 5 });

    t.fixture.clock.advance(11 * MINUTE);
    await t.fixture.queue.expireStaleJobs();

    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_capable_runner",
      attempts: 0,
    });
    // A Diff job is served by every runner and is not stranded by that deadline.
    expect((await t.fixture.queue.get(diff.id))?.status).toBe("queued");
    expect(await t.sessionOf(session.id)).toMatchObject({ status: "idle" });
  });

  // #752 review: `no_capable_runner` means there is none; a pool busy with long turns is not that.
  it("keeps a turn behind two 50-minute turns, and cancels it at the absolute limit of 3 hours", async () => {
    const t = await start({ limits: { leaseMs: 300 * MINUTE } });
    const first = await t.turn();
    const second = await t.turn();
    const waiting = await t.turn();
    expect((await t.fixture.queue.claimNext("r", IMPLEMENTER))?.job.id).toBe(
      first.job.id,
    );

    t.fixture.clock.advance(50 * MINUTE);
    await t.fixture.queue.complete(
      first.job.id,
      await t.fixture.tokenOf(first.job.id),
      { ok: true, result: {} },
    );
    expect((await t.fixture.queue.claimNext("r", IMPLEMENTER))?.job.id).toBe(
      second.job.id,
    );
    // 31 minutes after the creation, a capable runner is only busy: no cancellation.
    t.fixture.clock.advance(50 * MINUTE);
    expect((await t.fixture.queue.expireStaleJobs()).noCapableRunner).toBe(0);
    await t.fixture.queue.complete(
      second.job.id,
      await t.fixture.tokenOf(second.job.id),
      { ok: true, result: {} },
    );
    expect(await t.fixture.queue.get(waiting.job.id)).toMatchObject({
      status: "queued",
      attempts: 0,
    });

    // The pool is silent from here: the turn waits for the deadline after the last turn, then goes.
    t.fixture.clock.advance(30 * MINUTE);
    expect((await t.fixture.queue.expireStaleJobs()).noCapableRunner).toBe(1);
    expect(await t.fixture.queue.get(waiting.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_capable_runner",
      attempts: 0,
    });
  });

  // #752 second review: a turn whose runner crashed ended with lease_expired (never retried); that is no sign of a live pool.
  it("cancels a waiting turn at the deadline when the turn before it was lost with its runner", async () => {
    const t = await start();
    const lost = await t.turn();
    const waiting = await t.turn();
    expect((await t.fixture.queue.claimNext("r", IMPLEMENTER))?.job.id).toBe(
      lost.job.id,
    );

    t.fixture.clock.advance(30 * MINUTE);
    expect((await t.fixture.queue.expireStaleJobs()).noCapableRunner).toBe(1);

    expect(await t.fixture.queue.get(lost.job.id)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
    });
    expect(await t.fixture.queue.get(waiting.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_capable_runner",
    });
  });

  // #752 review
  it("cancels a turn at 3 hours although a turn of the pool still runs", async () => {
    const t = await start({
      limits: { leaseMs: 300 * MINUTE, implementerMaxRuntimeMs: 300 * MINUTE },
    });
    const running = await t.turn();
    const waiting = await t.turn();
    await t.fixture.queue.claimNext("r", IMPLEMENTER);

    t.fixture.clock.advance(180 * MINUTE - 2);
    expect((await t.fixture.queue.get(running.job.id))?.status).toBe("running");
    await t.fixture.queue.heartbeat(
      running.job.id,
      await t.fixture.tokenOf(running.job.id),
    );
    expect((await t.fixture.queue.expireStaleJobs()).noCapableRunner).toBe(0);

    t.fixture.clock.advance(2);
    expect((await t.fixture.queue.expireStaleJobs()).noCapableRunner).toBe(1);
    expect((await t.fixture.queue.get(waiting.job.id))?.errorCode).toBe(
      "no_capable_runner",
    );
  });
});

describe("the hard timeout", () => {
  // #752-T08
  it("fails an implementer job only after 70 minutes and a Diff job after 25, whatever the heartbeats say", async () => {
    const t = await start({ limits: { leaseMs: 200 * MINUTE } });
    const { job } = await t.turn();
    const diff = await t.fixture.enqueueNew({ prNumber: 5 });
    await t.fixture.queue.claimNext("r", IMPLEMENTER);
    await t.fixture.queue.claimNext("d", ["pr-agent"]);

    t.fixture.clock.advance(26 * MINUTE);
    await t.fixture.queue.expireStaleJobs();
    expect((await t.fixture.queue.get(diff.id))?.errorCode).toBe("timeout");
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "running",
    });

    t.fixture.clock.advance(43 * MINUTE); // 69 minutes in all
    await t.fixture.queue.expireStaleJobs();
    expect((await t.fixture.queue.get(job.id))?.status).toBe("running");

    t.fixture.clock.advance(2 * MINUTE); // 71
    await t.fixture.queue.expireStaleJobs();
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "timeout",
    });
  });

  // #752-T08
  it("fails a turn past 70 minutes through its own heartbeat too", async () => {
    const t = await start({ limits: { leaseMs: 200 * MINUTE } });
    const { job } = await t.turn();
    const claimed = await t.fixture.queue.claimNext("r", IMPLEMENTER);

    t.fixture.clock.advance(69 * MINUTE);
    expect(
      (await t.fixture.queue.heartbeat(job.id, claimed!.leaseToken)).status,
    ).toBe("ok");
    t.fixture.clock.advance(2 * MINUTE);
    expect(
      (await t.fixture.queue.heartbeat(job.id, claimed!.leaseToken)).status,
    ).toBe("not_holder");
    expect((await t.fixture.queue.get(job.id))?.errorCode).toBe("timeout");
  });
});

describe("a claim that the entitlements refuse", () => {
  // #752-T09
  it.each([
    [
      "workspace_suspended",
      entitlements({}, { suspended: true, suspensionCode: "overdue" }),
    ],
    ["quota_exhausted", entitlements({ dynamicRunsPerPeriod: 0 })],
  ])(
    "fails the turn with %s, names its kind to the refusal hook and sets the session idle",
    async (code, data) => {
      const refusals: ClaimRefusal[] = [];
      const t = await start({
        onRefused: (refusal) => refusals.push(refusal),
      });
      await createWorkspaceEntitlementsRepository(
        t.fixture.db,
        t.fixture.workspaceId,
        t.fixture.clock.now,
      ).put(data, null);
      const { job, session } = await t.turn();

      expect(await t.fixture.queue.claimNext("r", IMPLEMENTER)).toBeNull();

      expect(await t.fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: code,
        attempts: 0,
      });
      expect(refusals).toEqual([
        expect.objectContaining({
          jobId: job.id,
          errorCode: code,
          reviewKind: "implementer",
        }),
      ]);
      expect(await t.sessionOf(session.id)).toMatchObject({ status: "idle" });
      expect(
        await t.fixture.db.selectFrom("usage_records").selectAll().execute(),
      ).toEqual([]);
    },
  );
});
