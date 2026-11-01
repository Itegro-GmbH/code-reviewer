// SPDX-License-Identifier: LicenseRef-Proprietary

// #752: the checks on `usage_records.review_kind` and `billing_journal_entries.review_kind` take the kind `implementer`. The live
// database of code-reviewer.com runs this migration too, so it must change no row, bound every lock it takes, leave the session's
// settings as it found them and be safe to run again.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import {
  connectPostgres,
  createEmptyTestDatabase,
} from "../../test-support/test-database.ts";

const WIDEN = "20261030190000_widen_review_kind_checks_for_implementer";
const T = "2026-10-30T08:00:00.000Z";
const CHECK_VIOLATION = "23514";

/** The migrations the previous release's database ran: everything before the new one. */
const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < WIDEN,
      ),
    );
  },
};

async function seedPreviousRelease(db: Kysely<Database>) {
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', null, ${T})`.execute(
    db,
  );
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
    values ('i-1', 'w-1', 'github_app', 'acme', 'ext-1', '{}', 'active', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
    values ('r-1', 'w-1', 'i-1', 'repo-1', 'acme/x', 'https://github.test/acme/x', 1, ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args, trigger_kind, actor_login,
      status, run_after, attempts, created_at, updated_at)
    values ('j-1', 'w-1', 'r-1', 7, 'https://github.test/acme/x/pull/7', ${"a".repeat(40)}, 'review', '', 'webhook', 'octocat',
      'queued', ${T}, 0, ${T}, ${T})`.execute(db);
  await sql`insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args, trigger_kind, actor_login,
      status, run_after, attempts, created_at, updated_at)
    values ('j-2', 'w-1', 'r-1', 8, 'https://github.test/acme/x/pull/8', ${"b".repeat(40)}, 'review', '', 'webhook', 'octocat',
      'queued', ${T}, 0, ${T}, ${T}), ('j-3', 'w-1', 'r-1', 9, 'https://github.test/acme/x/pull/9', ${"c".repeat(40)}, 'review', '', 'webhook', 'octocat',
      'queued', ${T}, 0, ${T}, ${T})`.execute(db);
  await sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, state, reserved_at)
    values ('u-1', 'w-1', 'j-1', 'diff', 'managed', 'reserved', ${T})`.execute(
    db,
  );
  await sql`insert into billing_journal_entries (id, workspace_id, type, amount_micro_usd, ref_key, job_id, review_kind, minutes, ai_micro_usd, infra_micro_usd, created_at)
    values ('e-1', 'w-1', 'usage', -3, 'j-1', 'j-1', 'dynamic', 1, 1, 2, ${T})`.execute(
    db,
  );
}

async function constraintsOf(db: Kysely<Database>, table: string) {
  const { rows } = await sql<{
    name: string;
    definition: string;
    validated: boolean;
  }>`select conname as name, pg_get_constraintdef(oid) as definition, convalidated as validated
      from pg_constraint where conrelid = ${table}::regclass and contype = 'c' order by conname`.execute(
    db,
  );
  return rows;
}

async function rowsOf(db: Kysely<Database>, table: string) {
  return (
    await sql<unknown>`select * from ${sql.table(table)} order by 1`.execute(db)
  ).rows;
}

const insertRecord = (db: Kysely<Database>, kind: string) =>
  sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, state, reserved_at)
    values (${`u-${kind}`}, 'w-1', ${`j-${kind === "implementer" ? 2 : 3}`}, ${kind}, 'own', 'void', ${T})`.execute(
    db,
  );

const insertEntry = (db: Kysely<Database>, kind: string) =>
  sql`insert into billing_journal_entries (id, workspace_id, type, amount_micro_usd, ref_key, job_id, review_kind, minutes, ai_micro_usd, infra_micro_usd, created_at)
    values (${`e-${kind}`}, 'w-1', 'usage', -3, ${`k-${kind}`}, 'j-1', ${kind}, 1, 1, 2, ${T})`.execute(
    db,
  );

describe("the migration that widens the review kind checks", () => {
  // #752-T12
  it("accepts the kind implementer in usage records and journal entries, still refuses any other, and changes no row", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seedPreviousRelease(db);
    await expect(insertRecord(db, "implementer")).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    const before = {
      usage: await rowsOf(db, "usage_records"),
      journal: await rowsOf(db, "billing_journal_entries"),
      jobs: await rowsOf(db, "jobs"),
    };

    const { executed } = await migrateToLatest(db, migrationProvider);

    expect(executed).toContain(WIDEN);
    expect({
      usage: await rowsOf(db, "usage_records"),
      journal: await rowsOf(db, "billing_journal_entries"),
      jobs: await rowsOf(db, "jobs"),
    }).toEqual(before);
    await insertRecord(db, "implementer");
    await insertEntry(db, "implementer");
    await expect(insertRecord(db, "other")).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(insertEntry(db, "other")).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await db.destroy();
  });

  // #752-T12
  it("replaces only the two review kind checks, which stay validated, and leaves every other constraint as it was", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    const before = {
      usage: await constraintsOf(db, "usage_records"),
      journal: await constraintsOf(db, "billing_journal_entries"),
    };

    await migrateToLatest(db, migrationProvider);

    const after = {
      usage: await constraintsOf(db, "usage_records"),
      journal: await constraintsOf(db, "billing_journal_entries"),
    };
    const others = (constraints: typeof before.usage) =>
      constraints.filter((check) => !check.name.endsWith("review_kind_check"));
    expect(others(after.usage)).toEqual(others(before.usage));
    expect(others(after.journal)).toEqual(others(before.journal));
    for (const check of [
      ...after.usage.filter((c) => c.name.endsWith("review_kind_check")),
      ...after.journal.filter((c) => c.name.endsWith("review_kind_check")),
    ]) {
      expect(check.validated).toBe(true);
      expect(check.definition).toContain("implementer");
    }
    expect(
      after.usage.filter((c) => c.name.endsWith("review_kind_check")),
    ).toHaveLength(1);
    expect(
      after.journal.filter((c) => c.name.endsWith("review_kind_check")),
    ).toHaveLength(1);
    await db.destroy();
  });

  // #752-T12
  it("can be run again by hand: a second `up` changes nothing and does not fail", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    const before = {
      usage: await constraintsOf(db, "usage_records"),
      journal: await constraintsOf(db, "billing_journal_entries"),
    };
    const migrations = await migrationProvider.getMigrations();

    await db.transaction().execute((trx) => migrations[WIDEN]!.up(trx));

    expect({
      usage: await constraintsOf(db, "usage_records"),
      journal: await constraintsOf(db, "billing_journal_entries"),
    }).toEqual(before);
    await db.destroy();
  });

  // #752-T12
  it("keeps the lock and statement timeouts it sets to itself: a later migration of the same batch and the session do not inherit them", async () => {
    const { db } = await createEmptyTestDatabase({ poolMax: 1 });
    const seen: string[][] = [];
    const withProbe: MigrationProvider = {
      async getMigrations() {
        return {
          ...(await migrationProvider.getMigrations()),
          "99999999999999_probe": {
            async up(trx) {
              const { rows } = await sql<{
                lock: string;
                statement: string;
              }>`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`.execute(
                trx,
              );
              seen.push([rows[0]?.lock ?? "", rows[0]?.statement ?? ""]);
            },
          },
        };
      },
    };

    const { executed } = await migrateToLatest(db, withProbe);

    expect(executed.indexOf("99999999999999_probe")).toBeGreaterThan(
      executed.indexOf(WIDEN),
    );
    expect(seen).toEqual([["0", "0"]]);
    await db.destroy();
  });

  // #752-T12
  it.each(["usage_records", "billing_journal_entries"])(
    "gives up with MIGRATION_FAILED and leaves the old check in place when a writer keeps %s locked, then succeeds once it is gone",
    async (table) => {
      const { db, url } = await createEmptyTestDatabase();
      await migrateToLatest(db, beforeThisMigration);
      await seedPreviousRelease(db);
      const writer = connectPostgres(url, 1).db;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started: () => void = () => undefined;
      const writing = new Promise<void>((resolve) => {
        started = resolve;
      });
      // A transaction that has read the table with a lock mode that conflicts with the migration's, and does not end.
      const writerDone = writer.transaction().execute(async (trx) => {
        await sql`lock table ${sql.table(table)} in row exclusive mode`.execute(
          trx,
        );
        started();
        await held;
      });
      await writing;

      const startedAt = Date.now();
      await expect(
        migrateToLatest(db, migrationProvider),
      ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

      expect(Date.now() - startedAt).toBeLessThan(20_000);
      expect(
        (await constraintsOf(db, table)).find((check) =>
          check.name.endsWith("review_kind_check"),
        )?.definition,
      ).not.toContain("implementer");
      release();
      await writerDone;
      await expect(
        migrateToLatest(db, migrationProvider),
      ).resolves.toMatchObject({ executed: expect.arrayContaining([WIDEN]) });
      await writer.destroy();
      await db.destroy();
    },
    40_000,
  );

  // #752 second review: the sweep of `no_capable_runner` asks for the jobs a runner claimed and ended, per kind, under the gate lock.
  describe("the index for the jobs a runner ended", () => {
    const INDEX = "jobs_ended_after_claim";
    const indexOf = async (db: Kysely<Database>) =>
      (
        await sql<{
          definition: string;
        }>`select indexdef as definition from pg_indexes where tablename = 'jobs' and indexname = ${INDEX}`.execute(
          db,
        )
      ).rows[0]?.definition;

    // #752-T12
    it("adds a partial index on the kind and the end of the jobs that were claimed, and the sweep's lookup can use it", async () => {
      const { db } = await createEmptyTestDatabase();
      await migrateToLatest(db, beforeThisMigration);
      expect(await indexOf(db)).toBeUndefined();

      await migrateToLatest(db, migrationProvider);

      const definition = await indexOf(db);
      expect(definition).toContain("(review_kind, finished_at)");
      expect(definition).toContain("claimed_at IS NOT NULL");
      const plan = await db.transaction().execute(async (trx) => {
        await sql`set local enable_seqscan = off`.execute(trx);
        return sql<{
          "QUERY PLAN": string;
        }>`explain select id from jobs where review_kind = 'dynamic' and claimed_at is not null and finished_at > ${T}`.execute(
          trx,
        );
      });
      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
        INDEX,
      );
      await db.destroy();
    });

    // #752-T12
    it("can be run again by hand, and `down` removes only that index", async () => {
      const { db } = await createEmptyTestDatabase();
      await migrateToLatest(db, migrationProvider);
      const migrations = await migrationProvider.getMigrations();

      await db.transaction().execute((trx) => migrations[WIDEN]!.up(trx));
      expect(await indexOf(db)).toBeDefined();
      await db.transaction().execute((trx) => migrations[WIDEN]!.down!(trx));

      expect(await indexOf(db)).toBeUndefined();
      await db.destroy();
    });

    // #752-T12
    it("gives up with MIGRATION_FAILED and leaves neither the index nor the wider checks when a writer keeps jobs locked, then succeeds once it is gone", async () => {
      const { db, url } = await createEmptyTestDatabase();
      await migrateToLatest(db, beforeThisMigration);
      await seedPreviousRelease(db);
      const writer = connectPostgres(url, 1).db;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started: () => void = () => undefined;
      const writing = new Promise<void>((resolve) => {
        started = resolve;
      });
      const writerDone = writer.transaction().execute(async (trx) => {
        await sql`lock table jobs in row exclusive mode`.execute(trx);
        started();
        await held;
      });
      await writing;

      const startedAt = Date.now();
      await expect(
        migrateToLatest(db, migrationProvider),
      ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

      expect(Date.now() - startedAt).toBeLessThan(20_000);
      expect(await indexOf(db)).toBeUndefined();
      expect(
        (await constraintsOf(db, "usage_records")).find((check) =>
          check.name.endsWith("review_kind_check"),
        )?.definition,
      ).not.toContain("implementer");
      release();
      await writerDone;
      await expect(
        migrateToLatest(db, migrationProvider),
      ).resolves.toMatchObject({ executed: expect.arrayContaining([WIDEN]) });
      expect(await indexOf(db)).toBeDefined();
      await writer.destroy();
      await db.destroy();
    }, 40_000);
  });
});
