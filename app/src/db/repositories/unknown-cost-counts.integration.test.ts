// SPDX-License-Identifier: LicenseRef-Proprietary

// The count of runs that settled without a known cost, per workspace and key mode (#385; src/usage/README.md,
// "Counting unknown costs"), . The count is read from the
// usage records themselves, which the settlement writes in its own transaction, so every case below goes through
// the real queue (claim, complete, expiry) and then reads. The operator API on top is in
// integration-tests/http/operator-api-usage.integration.test.ts.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createJobQueueFixture,
  type JobQueueFixture,
} from "../../test-support/jobs.ts";
import { createUsageSeeder } from "../../test-support/usage-seed.ts";
import { addWorkspace } from "../../test-support/workspaces.ts";
import { createRunnerQueue } from "../../jobs/runner-queue.ts";
import {
  createUsageFeedRepository,
  type UnknownCostCount,
} from "./usage-feed-repository.ts";
import { createUsageRecordsRepository } from "./usage-records-repository.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { tableNames } from "../../test-support/tables.ts";

const MINUTE = 60 * 1000;
const ENGINES = ["pr-agent", "opencode"] as const;
/** A period that holds the whole test clock (which starts in October 2026). */
const WHOLE = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2027-01-01T00:00:00.000Z",
};

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

const usage = (costUsd: number | null) => ({
  ok: true as const,
  result: {
    ok: true,
    usage: { promptTokens: 100, completionTokens: 10, costUsd },
  },
});

describe("the count of unknown-cost settlements", () => {
  async function start() {
    const database = await open();
    const fixture = await createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      dynamicReview: true,
    });
    return { fixture, feed: createUsageFeedRepository(fixture.db) };
  }

  const recordsOf = (fixture: JobQueueFixture) =>
    createUsageRecordsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );

  let next = 0;
  /** A waiting job on a pull request of its own, a millisecond younger than the one before. */
  function enqueue(fixture: JobQueueFixture) {
    next += 1;
    fixture.clock.advance(1);
    return fixture.enqueueNew({ prNumber: 500 + next });
  }

  /** Claims one job, notes the key it ran on and completes it with a cost, as a runner would. */
  async function runToCompletion(
    fixture: JobQueueFixture,
    options: { costUsd: number | null; managed?: boolean },
  ) {
    const job = await enqueue(fixture);
    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
    expect(claimed?.job.id).toBe(job.id);
    if (options.managed === true)
      await recordsOf(fixture).setKeyMode(job.id, "managed");
    await fixture.queue.complete(
      job.id,
      claimed?.leaseToken ?? "",
      usage(options.costUsd),
    );
    return job;
  }

  const countsOf = async (feed: ReturnType<typeof createUsageFeedRepository>) =>
    (await feed.unknownCostCounts({ ...WHOLE, limit: 100 })).counts;

  // #385-T02
  it("does not count a run that settles with a known cost, not even a cost of zero", async () => {
    const { fixture, feed } = await start();

    await runToCompletion(fixture, { costUsd: 0.25 });
    await runToCompletion(fixture, { costUsd: 0, managed: true });

    expect(await countsOf(feed)).toEqual([]);
  });

  // #856-T75: a real claude-code turn on a customer's runner is in `runner-api/runner-subscription-cost.integration.test.ts`.
  it("counts a job that only says it ran through a subscription: the basis is not the runner's to name", async () => {
    const { fixture, feed } = await start();
    const job = await enqueue(fixture);
    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
    await fixture.queue.complete(job.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: {
        ok: true,
        usage: {
          promptTokens: 100,
          completionTokens: 10,
          costUsd: null,
          costBasis: "subscription",
          estimatedCostUsd: 0.42,
        },
      },
    });

    expect(await countsOf(feed)).toEqual([
      { workspaceId: fixture.workspaceId, keyMode: "own", unknownCostCount: 1 },
    ]);
    expect(await recordsOf(fixture).get(job.id)).toMatchObject({
      state: "settled",
      costMicroUsd: null,
      costBasis: null,
      promptTokens: 100,
    });
    const [group] = await recordsOf(fixture).summarize(WHOLE);
    expect(group).toMatchObject({ settledCount: 1, unknownCostCount: 1 });
  });

  // #385-T03
  it("counts a run of unknown cost under the key mode it ran on, own and operator's apart", async () => {
    const { fixture, feed } = await start();

    await runToCompletion(fixture, { costUsd: null });
    expect(await countsOf(feed)).toEqual([
      {
        workspaceId: fixture.workspaceId,
        keyMode: "own",
        unknownCostCount: 1,
      },
    ]);

    await runToCompletion(fixture, { costUsd: null, managed: true });
    expect(await countsOf(feed)).toEqual([
      {
        workspaceId: fixture.workspaceId,
        keyMode: "managed",
        unknownCostCount: 1,
      },
      {
        workspaceId: fixture.workspaceId,
        keyMode: "own",
        unknownCostCount: 1,
      },
    ]);

    await runToCompletion(fixture, { costUsd: null, managed: true });
    await runToCompletion(fixture, { costUsd: 1 });
    expect(await countsOf(feed)).toEqual([
      {
        workspaceId: fixture.workspaceId,
        keyMode: "managed",
        unknownCostCount: 2,
      },
      {
        workspaceId: fixture.workspaceId,
        keyMode: "own",
        unknownCostCount: 1,
      },
    ]);
  });

  // #385-T03
  it("counts a run whose tokens are known and whose cost is not", async () => {
    const { fixture, feed } = await start();

    await runToCompletion(fixture, { costUsd: null });

    expect(await recordsOf(fixture).summarize(WHOLE)).toMatchObject([
      { unknownCostCount: 1 },
    ]);
    expect(await countsOf(feed)).toHaveLength(1);
  });

  // #385-T03
  it("does not count a run that is still running", async () => {
    const { fixture, feed } = await start();
    const running = await enqueue(fixture);
    await fixture.queue.claimNext("runner-a", ENGINES);

    expect((await recordsOf(fixture).get(running.id))?.state).toBe("reserved");
    expect(await countsOf(feed)).toEqual([]);
  });

  // #385-T04
  it("counts a run that ended with no result once, also when the sweep runs again", async () => {
    const { fixture, feed } = await start();
    const job = await enqueue(fixture);
    // Only the last attempt ends a job without a result: the lease runs out on it.
    await fixture.db
      .updateTable("jobs")
      .set({ attempts: 2 })
      .where("id", "=", job.id)
      .execute();
    await fixture.queue.claimNext("runner-a", ENGINES);
    fixture.clock.advance(3 * MINUTE);

    await fixture.queue.expireStaleJobs();
    expect(await recordsOf(fixture).get(job.id)).toMatchObject({
      state: "settled",
      settledReason: "no_result",
    });
    expect(await countsOf(feed)).toEqual([
      {
        workspaceId: fixture.workspaceId,
        keyMode: "own",
        unknownCostCount: 1,
      },
    ]);

    await fixture.queue.expireStaleJobs();
    await fixture.queue.expireStaleJobs();
    fixture.clock.advance(3 * MINUTE);
    await fixture.queue.expireStaleJobs();

    expect(await countsOf(feed)).toEqual([
      {
        workspaceId: fixture.workspaceId,
        keyMode: "own",
        unknownCostCount: 1,
      },
    ]);
  });

  // #385-T05
  it("does not count a lost lease that is requeued, nor a repeated completion", async () => {
    const { fixture, feed } = await start();
    const job = await enqueue(fixture);

    // The first attempt is lost and the job waits again: nothing settled.
    await fixture.queue.claimNext("runner-a", ENGINES);
    fixture.clock.advance(3 * MINUTE);
    await fixture.queue.expireStaleJobs();
    expect((await fixture.queue.get(job.id))?.status).toBe("queued");
    expect(await countsOf(feed)).toEqual([]);

    // The second attempt completes without a cost, and says so again.
    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
    await fixture.queue.complete(
      job.id,
      claimed?.leaseToken ?? "",
      usage(null),
    );
    await fixture.queue.complete(
      job.id,
      claimed?.leaseToken ?? "",
      usage(null),
    );
    await fixture.queue.complete(job.id, claimed?.leaseToken ?? "", usage(0.5));

    expect(await countsOf(feed)).toEqual([
      {
        workspaceId: fixture.workspaceId,
        keyMode: "own",
        unknownCostCount: 1,
      },
    ]);
  });

  // #385-T06
  it("does not count a settlement whose transaction rolled back", async () => {
    const { fixture, feed } = await start();
    const job = await enqueue(fixture);

    await fixture.db
      .transaction()
      .execute(async (trx) => {
        const queue = createRunnerQueue(trx, { now: fixture.clock.now });
        const claimed = await queue.claimNext("runner-a", ENGINES);
        await queue.complete(job.id, claimed?.leaseToken ?? "", usage(null));
        // Inside the transaction the settlement is visible to its own reads...
        expect(
          (
            await createUsageFeedRepository(trx).unknownCostCounts({
              ...WHOLE,
              limit: 10,
            })
          ).counts,
        ).toHaveLength(1);
        throw new Error("rollback");
      })
      .catch(() => undefined);

    // ...and gone with it.
    expect(await countsOf(feed)).toEqual([]);
  });

  // #385-T07
  it("counts the settlements whose run started in the period, whenever they settled", async () => {
    const { fixture, feed } = await start();
    const seeder = createUsageSeeder(fixture.db);
    const seed = (reservedAt: string, settledAt: string) =>
      seeder.seed({
        workspaceId: fixture.workspaceId,
        reservedAt,
        settledAt,
      });
    await seed("2026-09-30T23:59:59.999Z", "2026-10-01T00:00:05.000Z"); // started before the period
    await seed("2026-10-01T00:00:00.000Z", "2026-10-01T00:00:01.000Z"); // from is included
    await seed("2026-10-31T23:59:59.000Z", "2026-11-01T00:00:30.000Z"); // started in, settled after
    await seed("2026-11-01T00:00:00.000Z", "2026-11-01T00:00:01.000Z"); // to is excluded

    const october = await feed.unknownCostCounts({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
      limit: 10,
    });

    expect(october.counts).toEqual([
      {
        workspaceId: fixture.workspaceId,
        keyMode: "own",
        unknownCostCount: 2,
      },
    ]);
    // It is the figure the summary of the same period gives, which is what a limit sees.
    expect(
      await recordsOf(fixture).summarize({
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-11-01T00:00:00.000Z",
      }),
    ).toMatchObject([{ unknownCostCount: 2 }]);
  });

  // #385-T08
  it("leaves the count of another workspace alone", async () => {
    const { fixture, feed } = await start();
    const other = await addWorkspace(fixture.db, "second");
    const seeder = createUsageSeeder(fixture.db);
    await seeder.seed({ workspaceId: other, keyMode: "managed" });
    const before = await createUsageRecordsRepository(
      fixture.db,
      other,
      fixture.clock.now,
    ).summarize(WHOLE);

    await runToCompletion(fixture, { costUsd: null });
    await seeder.seed({
      workspaceId: fixture.workspaceId,
      keyMode: "managed",
    });

    const after = await createUsageRecordsRepository(
      fixture.db,
      other,
      fixture.clock.now,
    ).summarize(WHOLE);
    expect(after).toEqual(before);
    const counts = await countsOf(feed);
    expect(counts.filter((count) => count.workspaceId === other)).toEqual([
      { workspaceId: other, keyMode: "managed", unknownCostCount: 1 },
    ]);
    expect(
      counts.filter((count) => count.workspaceId === fixture.workspaceId),
    ).toEqual([
      {
        workspaceId: fixture.workspaceId,
        keyMode: "managed",
        unknownCostCount: 1,
      },
      {
        workspaceId: fixture.workspaceId,
        keyMode: "own",
        unknownCostCount: 1,
      },
    ]);
  });

  // #385-T10
  it("neither loses nor repeats a settlement when many complete at once", async () => {
    const { fixture, feed } = await start();
    const jobs = [];
    const claims = [];
    for (let index = 0; index < 8; index += 1)
      jobs.push(await enqueue(fixture));
    for (const job of jobs) {
      const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
      expect(claimed?.job.id).toBe(job.id);
      claims.push(claimed);
      // Half of them ran on the operator's key.
      if (claims.length % 2 === 0)
        await recordsOf(fixture).setKeyMode(job.id, "managed");
    }

    // Every completion twice, all at the same time; two of the runs have a known cost.
    await Promise.all(
      claims.flatMap((claimed, index) => {
        const report = usage(index < 2 ? 0.5 : null);
        const id = claimed?.job.id ?? "";
        const token = claimed?.leaseToken ?? "";
        return [
          fixture.queue.complete(id, token, report),
          fixture.queue.complete(id, token, report),
        ];
      }),
    );

    expect(await countsOf(feed)).toEqual([
      {
        workspaceId: fixture.workspaceId,
        keyMode: "managed",
        unknownCostCount: 3,
      },
      {
        workspaceId: fixture.workspaceId,
        keyMode: "own",
        unknownCostCount: 3,
      },
    ]);
  });

  /** The usage seeder, the feed and four workspaces in the order the database sorts their ids. */
  async function setupWorkspaces() {
    const { fixture, feed } = await start();
    for (const slug of ["second", "third", "fourth"])
      await addWorkspace(fixture.db, slug);
    const workspaces = (
      await fixture.db
        .selectFrom("workspaces")
        .select("id")
        .orderBy("id")
        .execute()
    ).map((row) => row.id);
    return {
      fixture,
      feed,
      seeder: createUsageSeeder(fixture.db),
      workspaces,
    };
  }

  // #385-T03
  it("pages whole workspaces by id, so a workspace is never split across two pages", async () => {
    const t = await setupWorkspaces();
    for (const workspaceId of t.workspaces) {
      await t.seeder.seed({ workspaceId, keyMode: "own" });
      await t.seeder.seed({ workspaceId, keyMode: "managed" });
    }
    const [a, b, c, d] = t.workspaces;

    const first = await t.feed.unknownCostCounts({ ...WHOLE, limit: 2 });
    const second = await t.feed.unknownCostCounts({
      ...WHOLE,
      limit: 2,
      after: first.nextAfter ?? "",
    });

    expect(
      first.counts.map((count) => `${count.workspaceId}/${count.keyMode}`),
    ).toEqual([`${a}/managed`, `${a}/own`, `${b}/managed`, `${b}/own`]);
    expect(first.nextAfter).toBe(b);
    expect(
      second.counts.map((count) => `${count.workspaceId}/${count.keyMode}`),
    ).toEqual([`${c}/managed`, `${c}/own`, `${d}/managed`, `${d}/own`]);
    // A page that is not full is the last one.
    expect(second.nextAfter).toBeNull();
  });

  // #385-T03
  it("lists no workspace without an unknown cost, and answers an empty period with nothing", async () => {
    const t = await setupWorkspaces();
    await t.seeder.seed({
      workspaceId: t.workspaces[0] ?? "",
      costMicroUsd: 5,
    });
    await t.seeder.seed({
      workspaceId: t.workspaces[1] ?? "",
      state: "reserved",
    });
    await t.seeder.seed({
      workspaceId: t.workspaces[2] ?? "",
      state: "void",
    });

    expect(await t.feed.unknownCostCounts({ ...WHOLE, limit: 10 })).toEqual({
      counts: [],
      nextAfter: null,
    });
  });

  // #385-T03
  it("gives a figure the summary of the workspace agrees with", async () => {
    const t = await setupWorkspaces();
    const workspaceId = t.workspaces[0] ?? "";
    await t.seeder.seed({ workspaceId, reviewKind: "diff", keyMode: "own" });
    await t.seeder.seed({
      workspaceId,
      reviewKind: "dynamic",
      keyMode: "own",
    });
    await t.seeder.seed({
      workspaceId,
      reviewKind: "dynamic",
      keyMode: "own",
      costMicroUsd: 3,
    });

    const counts: UnknownCostCount[] = (
      await t.feed.unknownCostCounts({ ...WHOLE, limit: 10 })
    ).counts;
    const summary = await createUsageRecordsRepository(
      t.fixture.db,
      workspaceId,
    ).summarize(WHOLE);

    // Per key mode, the unknown costs of both kinds add up to what the summary lists per kind and key mode.
    expect(counts).toEqual([
      { workspaceId, keyMode: "own", unknownCostCount: 2 },
    ]);
    expect(
      summary.reduce((sum, group) => sum + group.unknownCostCount, 0),
    ).toBe(2);
  });
});

describe("the count for an instance without entitlements", () => {
  // #385-T01
  it("writes nothing new for an instance without entitlements: a run that settles without a cost adds a row to nothing but the usage records", async () => {
    const fixture = await createJobQueueFixture();
    const t = { fixture, feed: createUsageFeedRepository(fixture.db) };
    const rowsPerTable = async () => {
      const counts: Record<string, number> = {};
      for (const name of await tableNames(t.fixture.db)) {
        const row = await sql<{
          n: number;
        }>`select count(*)::int as n from ${sql.table(name)}`.execute(
          t.fixture.db,
        );
        counts[name] = Number(row.rows[0]?.n);
      }
      return counts;
    };
    const job = await t.fixture.enqueueNew();
    const before = await rowsPerTable();

    const claimed = await t.fixture.queue.claimNext("runner-a", ENGINES);
    await t.fixture.queue.complete(
      job.id,
      claimed?.leaseToken ?? "",
      usage(null),
    );

    const after = await rowsPerTable();
    const changed = Object.keys(after).filter(
      (name) => after[name] !== before[name],
    );
    expect(changed).toEqual(["usage_records"]);
    expect(after.workspace_entitlements).toBe(0);
    // And the count is there to read: the operator API serving it is off until its token is set.
    expect(
      (await t.feed.unknownCostCounts({ ...WHOLE, limit: 10 })).counts,
    ).toHaveLength(1);
  });
});
