// SPDX-License-Identifier: LicenseRef-Proprietary

// #751: the implementer migration is expand only. It adds two empty tables and one unique index to a database made by the
// previous release's migrations (the live one has jobs, the factory's has few), changes no existing row, and gives up
// loudly instead of making the queue wait when a writer holds `jobs`.
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
import { addUser } from "../../test-support/workspace-deletion-fixture.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const SPLIT = "20261030140000_create_implementer_sessions_and_turns";
const T = "2026-10-30T08:00:00.000Z";
const NEW_TABLES = ["implementer_sessions", "implementer_turns"];

/** The migrations the previous release's database ran: everything before the new one. */
const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < SPLIT,
      ),
    );
  },
};

/** The migrations up to and including this one: a later migration may add an index of its own to `jobs`. */
const throughThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name <= SPLIT,
      ),
    );
  },
};

async function rowsOfEveryOldTable(
  db: Kysely<Database>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (NEW_TABLES.includes(table.name)) continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)} order by 1`.execute(
        db,
      );
    result[table.name] = withoutColumnsAddedLater(table.name, rows);
  }
  return result;
}

/** A workspace with an installation, a repository and a job, the way the live database has them. */
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
}

/** A write that leaves a lock on one of the tables the new tables point at. */
const WRITE_TO: Record<string, (trx: Kysely<Database>) => Promise<unknown>> = {
  users: (trx) =>
    sql`update users set name = 'renamed' where id = 'u-1'`.execute(trx),
  repositories: (trx) =>
    sql`update repositories set updated_at = ${T} where id = 'r-1'`.execute(
      trx,
    ),
  workspaces: (trx) =>
    sql`update workspaces set name = 'renamed' where id = 'w-1'`.execute(trx),
};

/** Waits until a statement of the migration waits for a lock (seen from another connection). */
async function waitUntilBlocked(observer: Kysely<Database>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const { rows } = await sql<{
      blocked: number;
    }>`select count(*)::int as blocked from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`.execute(
      observer,
    );
    if ((rows[0]?.blocked ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the migration never waited for the writer");
}

describe("the implementer migration", () => {
  // #751-T01
  it("adds two empty tables to an existing database with data and changes no existing row", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seedPreviousRelease(db);
    const before = await rowsOfEveryOldTable(db);
    expect(
      (await db.introspection.getTables()).map((table) => table.name),
    ).not.toContain("implementer_sessions");

    const { executed } = await migrateToLatest(db, migrationProvider);

    expect(executed).toContain(SPLIT);
    expect(await rowsOfEveryOldTable(db)).toEqual(before);
    const { rows } = await sql<{
      sessions: number;
      turns: number;
    }>`select (select count(*) from implementer_sessions)::int as sessions,
              (select count(*) from implementer_turns)::int as turns`.execute(
      db,
    );
    expect(rows).toEqual([{ sessions: 0, turns: 0 }]);
    await db.destroy();
  });

  // #751-T01
  it("is applied once: running it again applies nothing", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const again = await migrateToLatest(db, migrationProvider);

    expect(again.executed).toEqual([]);
    await db.destroy();
  });

  // #751-T01
  it("adds exactly one index to jobs and leaves the others as they were", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    const indexesOfJobs = async () =>
      (
        await sql<{
          name: string;
        }>`select indexname as name from pg_indexes where tablename = 'jobs' order by indexname`.execute(
          db,
        )
      ).rows.map((row) => row.name);
    const before = await indexesOfJobs();

    await migrateToLatest(db, throughThisMigration);

    const after = await indexesOfJobs();
    expect(after.filter((name) => !before.includes(name))).toEqual([
      "jobs_id_workspace_unique",
    ]);
    expect(before.filter((name) => !after.includes(name))).toEqual([]);
    await db.destroy();
  });

  // #751-T01
  it("keeps the lock timeout it sets to itself: a later migration of the same batch and the session do not inherit it", async () => {
    const { db, config } = await createEmptyTestDatabase({ poolMax: 1 });
    expect(config.poolMax).toBe(1);
    // `set local` ends at commit anyway, so only a migration that runs in the same transaction can see a missing restore.
    const seenByLaterMigration: string[] = [];
    const withProbe: MigrationProvider = {
      async getMigrations() {
        return {
          ...(await migrationProvider.getMigrations()),
          "99999999999999_probe_lock_timeout": {
            async up(trx) {
              const { rows } = await sql<{
                value: string;
              }>`select current_setting('lock_timeout') as value`.execute(trx);
              seenByLaterMigration.push(rows[0]?.value ?? "");
            },
          },
        };
      },
    };

    const { executed } = await migrateToLatest(db, withProbe);

    expect(
      executed.indexOf("99999999999999_probe_lock_timeout"),
    ).toBeGreaterThan(executed.indexOf(SPLIT));
    expect(seenByLaterMigration).toEqual(["0"]);
    const { rows } = await sql<{
      lock_timeout: string;
    }>`show lock_timeout`.execute(db);
    expect(rows).toEqual([{ lock_timeout: "0" }]);
    await db.destroy();
  });

  // #751-T01
  it("gives up with MIGRATION_FAILED and leaves nothing half applied when a writer keeps jobs locked, then succeeds once it is gone", async () => {
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
    // A transaction that has written a job and does not end: the index build has to wait for it.
    const writerDone = writer.transaction().execute(async (trx) => {
      await sql`update jobs set updated_at = ${T} where id = 'j-1'`.execute(
        trx,
      );
      started();
      await held;
    });
    await writing;

    const startedAt = Date.now();
    await expect(migrateToLatest(db, migrationProvider)).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
    });
    const waitedMs = Date.now() - startedAt;

    expect(waitedMs).toBeLessThan(20_000);
    expect(
      (await db.introspection.getTables()).map((table) => table.name),
    ).not.toContain("implementer_sessions");
    release();
    await writerDone;
    await expect(migrateToLatest(db, migrationProvider)).resolves.toMatchObject(
      { executed: expect.arrayContaining([SPLIT]) },
    );
    await db.destroy();
  }, 40_000);
  // #751-T01
  it.each(["users", "repositories", "workspaces"])(
    "does not make a jobs write wait while the migration waits for a writer on %s",
    async (table) => {
      const { db, url } = await createEmptyTestDatabase();
      await migrateToLatest(db, beforeThisMigration);
      await seedPreviousRelease(db);
      await addUser(db, "u-1");
      const writer = connectPostgres(url, 1).db;
      const queue = connectPostgres(url, 1).db;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started: () => void = () => undefined;
      const writing = new Promise<void>((resolve) => {
        started = resolve;
      });
      // A transaction that has written a row of the table and does not end: the foreign key of a new table has to wait for it.
      const writerDone = writer.transaction().execute(async (trx) => {
        await WRITE_TO[table]!(trx);
        started();
        await held;
      });
      await writing;

      const migrating = migrateToLatest(db, migrationProvider);
      // Reaching the wait is what the test is about: the migration is blocked on a lock now.
      await waitUntilBlocked(queue);
      const startedAt = Date.now();
      // The queue's own write, with a bound far below the migration's: it must not be stuck behind the migration.
      const write = await queue
        .transaction()
        .execute(async (trx) => {
          await sql`set local lock_timeout = '1500ms'`.execute(trx);
          await sql`update jobs set updated_at = ${T} where id = 'j-1'`.execute(
            trx,
          );
          return { waitedMs: Date.now() - startedAt };
        })
        .catch((error: unknown) => ({ failed: String(error) }));
      // Let go of the writer in any case, so a failure here is fast and the migration ends.
      release();
      await writerDone;
      const migration = await migrating.then(
        (result) => result,
        () => "MIGRATION_FAILED",
      );

      expect(write).toEqual({ waitedMs: expect.any(Number) });
      expect((write as { waitedMs: number }).waitedMs).toBeLessThan(1_000);
      expect(migration).toMatchObject({
        executed: expect.arrayContaining([SPLIT]),
      });
      await queue.destroy();
      await writer.destroy();
      await db.destroy();
    },
    40_000,
  );
});
