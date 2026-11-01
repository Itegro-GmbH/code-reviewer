// SPDX-License-Identifier: LicenseRef-Proprietary

// The job queue on Postgres: the partial unique index on running jobs per pull request exists, many runners never get
// the same job and never start two jobs of one pull request, and a unique violation inside the claim (the slot was taken
// at the same moment) is skipped, not raised.
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createJobQueue } from "../jobs/job-queue.ts";
import { createStoredReviewKindResolver } from "../jobs/review-kind.ts";
import { createInstanceDynamicReviewGate } from "../jobs/dynamic-review-gate.ts";
import { createInstanceSettingsRepository } from "./repositories/instance-settings-repository.ts";
import { createProjectsRepository } from "./repositories/projects-repository.ts";
import { createAppSettingsRepository } from "./repositories/app-settings-repository.ts";
import { createJobReviewSettingsHooks } from "../jobs/review-settings-hooks.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { createRunnerQueue } from "../jobs/runner-queue.ts";
import type { Database } from "./schema.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import {
  connectPostgres,
  createTestDatabase,
} from "../test-support/test-database.ts";

const RUNNING_INDEX = "jobs_one_running_per_pull_request_unique";
const T = "2026-10-10T12:00:00.000Z";

/** `postgres://...?application_name=<name>`, so a backend can be found in `pg_stat_activity`. */
function withApplicationName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", name);
  return parsed.toString();
}

/**
 * Waits until the backend of `name` is waiting on a lock, so the test can release the holder at a
 * moment it can name instead of guessing. Bounded: a bug fails the test instead of hanging.
 */
async function waitForLockWait(
  db: Kysely<Database>,
  name: string,
  timeoutMs = 5000,
  holderName?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from pg_stat_activity
      where application_name = ${name} and wait_event_type = 'Lock'`.execute(
      db,
    );
    if ((rows[0]?.count ?? 0) > 0) {
      if (holderName !== undefined) {
        const { rows: holders } = await sql<{ application_name: string }>`
          select holder.application_name from pg_stat_activity waiter
          join pg_stat_activity holder on holder.pid = any(pg_blocking_pids(waiter.pid))
          where waiter.application_name = ${name}`.execute(db);
        expect(holders.map((row) => row.application_name)).toEqual([
          holderName,
        ]);
      }
      return;
    }
    if (Date.now() >= deadline)
      throw new Error(`Backend ${name} never waited on a lock.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the job queue on Postgres", () => {
  // #105-PG-20
  it("has the partial unique index on a running status, one running job per pull request", async () => {
    const postgres = await createTestDatabase();
    const { rows } = await sql<{ definition: string }>`
      select indexdef as definition from pg_indexes
      where indexname = ${RUNNING_INDEX}`.execute(postgres.db);

    expect(rows[0]?.definition).toMatch(/UNIQUE/);
    expect(rows[0]?.definition).toMatch(/status.*running/i);
  });

  // #105-PG-07
  it("never gives one job to two runners and never runs two jobs of one pull request", async () => {
    const postgres = await createTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    for (let pr = 1; pr <= 4; pr += 1)
      for (const head of ["a", "b", "c"] as const)
        await fixture.enqueueNew({
          prNumber: pr,
          prUrl: `https://github.test/acme/widgets/pull/${String(pr)}`,
          headSha: sha(head),
        });

    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        fixture.queue.claimNext(`runner-${String(index)}`),
      ),
    );
    const claimedIds = claims.flatMap((claim) =>
      claim === null ? [] : [claim.job.id],
    );

    // No job was handed out twice, and every claim produced a running job.
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    const running = await postgres.db
      .selectFrom("jobs")
      .select(["repository_id", "pr_number"])
      .where("status", "=", "running")
      .execute();
    expect(running).toHaveLength(claimedIds.length);
    // At most one running job per pull request.
    const perPullRequest = running.map(
      (row) => `${row.repository_id}:${String(row.pr_number)}`,
    );
    expect(new Set(perPullRequest).size).toBe(perPullRequest.length);
    // Nothing was lost.
    const { rows: counts } = await sql<{ count: number }>`
      select count(*)::int as count from jobs`.execute(postgres.db);
    expect(counts[0]?.count).toBe(12);
  });

  // #105-PG-20
  it("gives only one of two jobs of one pull request to two runners at the same moment", async () => {
    const postgres = await createTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    const first = await fixture.enqueueNew({ prNumber: 7, headSha: sha("a") });
    const second = await fixture.enqueueNew({ prNumber: 7, headSha: sha("b") });
    const other = await fixture.enqueueNew({ prNumber: 8, headSha: sha("c") });

    const [one, two] = await Promise.all([
      fixture.queue.claimNext("runner-1"),
      fixture.queue.claimNext("runner-2"),
    ]);
    const claimedIds = [one?.job.id, two?.job.id].filter(
      (id): id is string => id !== undefined,
    );

    // Exactly one of the two jobs of pull request 7, and the runner that lost the race took the
    // job of pull request 8.
    expect(
      claimedIds.filter((id) => id === first.id || id === second.id),
    ).toHaveLength(1);
    expect(claimedIds).toContain(other.id);
  });

  // #105-PG-21
  it("skips a job whose running slot was taken at the same moment and claims the next one", async () => {
    const postgres = await createTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    await fixture.enqueueNew({ prNumber: 7, headSha: sha("a") });
    // A later created_at makes the pull request 7 job unambiguously the oldest due job; the claim
    // breaks ties of equal timestamps by the random id, which would make this test flaky.
    fixture.clock.advance(1000);
    await fixture.enqueueNew({ prNumber: 7, headSha: sha("b") });
    fixture.clock.advance(1000);
    const next = await fixture.enqueueNew({ prNumber: 8, headSha: sha("c") });

    // A second connection holds a running job of pull request 7 without committing. The claim's
    // snapshot does not see it, so it tries to run a job of pull request 7; the unique index does,
    // so that update raises a duplicate key error.
    const holder = connectPostgres(
      withApplicationName(postgres.url, "cr_hold"),
    );
    await sql`begin`.execute(holder.db);
    await sql`
      insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args,
                        trigger_kind, actor_login, delivery_id, status, run_after, attempts, runner_id,
                        lease_token, claimed_at, heartbeat_at, lease_expires_at, result, error_code,
                        superseded_by, created_at, updated_at, finished_at)
      values (${randomUUID()}, ${fixture.workspaceId}, ${fixture.repositoryId}, 7,
              'https://github.test/acme/widgets/pull/7', ${sha("f")}, 'review', '', 'webhook',
              'octocat', null, 'running', ${T}, 0, 'holder', 'holder-token', ${T}, ${T}, null, null,
              null, null, ${T}, ${T}, null)`.execute(holder.db);

    const waiter = connectPostgres(
      withApplicationName(postgres.url, "cr_waiter"),
    );
    const queue = createRunnerQueue(waiter.db, { now: fixture.clock.now });
    const pending = queue.claimNext("runner-1");
    await waitForLockWait(postgres.db, "cr_waiter");
    await sql`commit`.execute(holder.db);

    const claimed = await pending;
    await holder.close();
    await waiter.close();

    // The transaction survived: the claim skipped pull request 7 and took pull request 8.
    expect(claimed?.job.id).toBe(next.id);
  });

  // #105-PG-09
  it("claims on one instance and heartbeats and completes on another", async () => {
    const postgres = await createTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    const job = await fixture.enqueueNew({ prNumber: 7, headSha: sha("a") });

    const first = connectPostgres(postgres.url);
    const second = connectPostgres(postgres.url);
    const claim = await createRunnerQueue(first.db, {
      now: fixture.clock.now,
    }).claimNext("runner-1");
    expect(claim?.job.id).toBe(job.id);
    const leaseToken = claim?.leaseToken ?? "";

    // The state lives in the database, not in the process: another connection (another instance)
    // continues the claim with the same lease token.
    const other = createRunnerQueue(second.db, { now: fixture.clock.now });
    expect((await other.heartbeat(job.id, leaseToken)).status).toBe("ok");
    expect(
      (
        await other.complete(job.id, leaseToken, {
          ok: true,
          result: { note: "done" },
        })
      ).status,
    ).toBe("completed");

    await first.close();
    await second.close();
  });

  // #195-T02, #195 finding 9: the capability predicate is inside the atomic claim on Postgres too.
  it("hands each capability only the kinds it can run and keeps one holder per pull request", async () => {
    const postgres = await createTestDatabase();
    const fixture = await createJobQueueFixture({
      database: postgres.db,
      dynamicReview: true,
    });
    const dynamic = await fixture.enqueueNew({
      prNumber: 7,
      headSha: sha("a"),
      reviewKind: "dynamic",
    });
    fixture.clock.advance(1000);
    const diff = await fixture.enqueueNew({
      prNumber: 8,
      headSha: sha("b"),
      reviewKind: "diff",
    });

    const prAgentOnly = await fixture.queue.claimNext("runner-a", ["pr-agent"]);
    const dual = await fixture.queue.claimNext("runner-b", [
      "pr-agent",
      "opencode",
    ]);

    expect(prAgentOnly?.job.id).toBe(diff.id);
    expect(dual?.job.id).toBe(dynamic.id);
  });

  // #746-T07: the engine of the Implementer is in the contract before its jobs are in the queue; naming it alone claims
  // nothing, and naming it next to the others changes nothing for them.
  it("gives a runner that names only the implementer engine no job, and leaves the others as they were", async () => {
    const postgres = await createTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    const diff = await fixture.enqueueNew({
      prNumber: 7,
      headSha: sha("a"),
      reviewKind: "diff",
    });

    const alone = await fixture.queue.claimNext("runner-a", ["implementer"]);
    const withOthers = await fixture.queue.claimNext("runner-b", [
      "pr-agent",
      "implementer",
    ]);

    expect(alone).toBeNull();
    expect(withOthers?.job.id).toBe(diff.id);
  });

  // #195-T02, #195 finding 9
  it("never gives two capabilities a job of one pull request across kinds", async () => {
    const postgres = await createTestDatabase();
    const fixture = await createJobQueueFixture({
      database: postgres.db,
      dynamicReview: true,
    });
    const dynamic = await fixture.enqueueNew({
      prNumber: 7,
      headSha: sha("a"),
      reviewKind: "dynamic",
    });
    fixture.clock.advance(1000);
    const diff = await fixture.enqueueNew({
      prNumber: 7,
      headSha: sha("b"),
      reviewKind: "diff",
    });
    fixture.clock.advance(1000);
    const other = await fixture.enqueueNew({
      repositoryId: fixture.otherRepositoryId,
      prNumber: 8,
      headSha: sha("c"),
      reviewKind: "diff",
    });

    const [one, two] = await Promise.all([
      fixture.queue.claimNext("runner-a", ["pr-agent"]),
      fixture.queue.claimNext("runner-b", ["pr-agent", "opencode"]),
    ]);
    const ids = [one?.job.id, two?.job.id].filter(
      (id): id is string => id !== undefined,
    );
    expect(ids).toHaveLength(2);
    expect(ids).toContain(other.id);
    expect(
      ids.filter((id) => id === dynamic.id || id === diff.id),
    ).toHaveLength(1);
    expect(one?.job.reviewKind).toBe("diff");
    expect(new Set(ids).size).toBe(ids.length);

    const running = await postgres.db
      .selectFrom("jobs")
      .select(["id"])
      .where("repository_id", "=", fixture.repositoryId)
      .where("pr_number", "=", 7)
      .where("status", "=", "running")
      .execute();
    expect(running).toHaveLength(1);
    for (const claim of [one, two]) {
      expect(claim).not.toBeNull();
      expect(
        await fixture.queue.complete(claim!.job.id, claim!.leaseToken, {
          ok: true,
          result: {},
        }),
      ).toMatchObject({ status: "completed" });
    }
    const next = await fixture.queue.claimNext("runner-next", [
      "pr-agent",
      "opencode",
    ]);
    expect(next?.job.id).toBe(ids.includes(dynamic.id) ? diff.id : dynamic.id);
    expect(
      await fixture.queue.complete(next!.job.id, next!.leaseToken, {
        ok: true,
        result: {},
      }),
    ).toMatchObject({ status: "completed" });
  });
  // #195-T04: PostgreSQL must hold the settings lock from kind resolution through insertion.
  it.each(["webhook", "manual", "comment"] as const)(
    "serializes a %s enqueue with a kind change",
    async (triggerKind) => {
      const postgres = await createTestDatabase();
      const fixture = await createJobQueueFixture({
        database: postgres.db,
        dynamicReview: true,
      });
      const writer = connectPostgres(
        withApplicationName(postgres.url, "cr_kind_writer"),
      );
      const projects = createProjectsRepository(
        writer.db,
        fixture.workspaceId,
        fixture.clock.now,
      );
      await projects.activate(fixture.repositoryId);
      const service = createReviewSettingsService({
        appSettings: createAppSettingsRepository(
          writer.db,
          fixture.workspaceId,
        ),
        projects,
        builtIn: () => builtInReviewSettings("test/model"),
        hooks: createJobReviewSettingsHooks(fixture.workspaceId),
      });
      let resume!: () => void;
      let read!: () => void;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        read = resolve;
      });
      const enqueuer = connectPostgres(
        withApplicationName(postgres.url, "cr_kind_enqueue"),
      );
      const resolver = createStoredReviewKindResolver(fixture.workspaceId);
      const queue = createJobQueue(enqueuer.db, fixture.workspaceId, {
        now: fixture.clock.now,
        reviewKind: async (trx, id) => {
          const kind = await resolver(trx, id);
          read();
          await paused;
          return kind;
        },
      });
      const enqueue = queue.enqueue({
        repositoryId: fixture.repositoryId,
        prNumber: 7,
        prUrl: "https://github.test/acme/widgets/pull/7",
        headSha: sha("a"),
        command: "review",
        triggerKind,
        actorLogin: "octocat",
      });
      await Promise.race([
        reached,
        enqueue.then(() => {
          throw new Error("Enqueue did not reach the paused read.");
        }),
      ]);
      const change = service.updateProjectSettings(fixture.repositoryId, {
        reviewKind: "dynamic",
      });
      try {
        await waitForLockWait(
          postgres.db,
          "cr_kind_writer",
          5000,
          "cr_kind_enqueue",
        );
      } finally {
        resume();
        await enqueue;
        await change;
      }
      const result = await enqueue;
      expect(await queue.get(result.job.id)).toMatchObject({
        status: "cancelled",
        errorCode: "review_kind_changed",
      });
    },
  );

  // #195-T04: disabling must wait for an enqueue that already read the enabled gate, then fence it.
  it.each([true, false])(
    "serializes gate disable with an in-flight Dynamic enqueue when a saved enabled gate exists: %s",
    async (savedGate) => {
      const postgres = await createTestDatabase();
      const fixture = await createJobQueueFixture({ database: postgres.db });
      const settings = createInstanceSettingsRepository(
        postgres.db,
        fixture.clock.now,
      );
      if (savedGate)
        await settings.set("dynamic_review", { enabled: true }, null);
      const writer = connectPostgres(
        withApplicationName(postgres.url, "cr_gate_writer"),
      );
      let resume!: () => void;
      let read!: () => void;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        read = resolve;
      });
      const enqueuer = connectPostgres(
        withApplicationName(postgres.url, "cr_gate_enqueue"),
      );
      const gate = createInstanceDynamicReviewGate();
      const queue = createJobQueue(enqueuer.db, fixture.workspaceId, {
        now: fixture.clock.now,
        dynamicReviewEnabled: async (trx) => {
          const enabled = await gate(trx);
          read();
          await paused;
          return enabled;
        },
      });
      const enqueue = queue.enqueue({
        repositoryId: fixture.repositoryId,
        prNumber: 7,
        prUrl: "https://github.test/acme/widgets/pull/7",
        headSha: sha("a"),
        reviewKind: "dynamic",
        command: "review",
        triggerKind: "manual",
        actorLogin: "octocat",
      });
      await Promise.race([
        reached,
        enqueue.then(() => {
          throw new Error("Enqueue did not reach the paused read.");
        }),
      ]);
      const disable = createInstanceSettingsRepository(
        writer.db,
        fixture.clock.now,
      ).set("dynamic_review", { enabled: false }, null);
      try {
        await waitForLockWait(
          postgres.db,
          "cr_gate_writer",
          5000,
          "cr_gate_enqueue",
        );
      } finally {
        resume();
        await enqueue;
        await disable;
      }
      expect(await queue.get((await enqueue).job.id)).toMatchObject({
        status: savedGate ? "cancelled" : "failed",
        errorCode: "dynamic_review_disabled",
      });
    },
  );
  // #195-T04: PostgreSQL rollback must leave no live Dynamic row an older app could reclaim.
  it("preserves the running Dynamic lease on disable and fails its expiry before rollback", async () => {
    const postgres = await createTestDatabase();
    const fixture = await createJobQueueFixture({ database: postgres.db });
    const settings = createInstanceSettingsRepository(
      postgres.db,
      fixture.clock.now,
    );
    await settings.set("dynamic_review", { enabled: true }, null);
    const running = await fixture.enqueueNew({ reviewKind: "dynamic" });
    const claim = await fixture.queue.claimNext("runner", ["opencode"]);
    expect(claim?.job.id).toBe(running.id);
    const waiting = await fixture.enqueueNew({
      reviewKind: "dynamic",
      prNumber: 8,
    });
    await settings.set("dynamic_review", { enabled: false }, null);
    expect(await fixture.queue.get(running.id)).toEqual(claim?.job);
    fixture.clock.advance(60 * 60 * 1000);
    expect((await fixture.queue.expireStaleJobs()).requeued).toBe(0);
    expect(await fixture.queue.get(running.id)).toMatchObject({
      status: "failed",
      errorCode: "dynamic_review_disabled",
    });
    expect(await fixture.queue.get(waiting.id)).toMatchObject({
      status: "cancelled",
      errorCode: "dynamic_review_disabled",
    });
    expect(
      await fixture.queue.release(
        running.id,
        claim!.leaseToken,
        "runner_shutdown",
      ),
    ).toMatchObject({ status: "not_holder" });
    expect(
      await fixture.queue.heartbeat(running.id, claim!.leaseToken),
    ).toMatchObject({ status: "not_holder" });
    expect(
      await fixture.queue.complete(running.id, claim!.leaseToken, {
        ok: true,
        result: {},
      }),
    ).toMatchObject({ status: "outcome_conflict" });
    const { rows } = await sql<{
      count: number;
    }>`select count(*)::int as count from jobs where review_kind = 'dynamic' and status in ('queued', 'running')`.execute(
      postgres.db,
    );
    expect(rows[0]?.count).toBe(0);
  });
});
