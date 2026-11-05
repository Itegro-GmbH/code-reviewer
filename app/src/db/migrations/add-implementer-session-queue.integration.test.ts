// SPDX-License-Identifier: LicenseRef-Proprietary

// #841: the migration that adds the queued instruction to a session is expand only. Two nullable columns are added to a table that
// holds rows, no existing row changes (every old session reads null), and the migration gives up loudly instead of making the queue
// wait when a writer holds the table.
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
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const THIS = "20261105160000_add_implementer_session_queue";
const T = "2026-11-05T08:00:00.000Z";

const before: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

/** The migrations up to and including this one: a later migration may add tables and indexes of its own. */
const throughThis: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name <= THIS,
      ),
    );
  },
};

/** The rows of the tables that exist now, without the columns later migrations add. */
async function rowsOf(
  db: Kysely<Database>,
  tables: readonly string[],
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table)} order by 1`.execute(
        db,
      );
    result[table] = withoutColumnsAddedLater(table, rows);
  }
  return result;
}

async function tableNames(db: Kysely<Database>): Promise<string[]> {
  return (await db.introspection.getTables()).map((table) => table.name);
}

/** A session the way the live database has it: a workspace, a repository, a job, a running session and its turn. */
async function seedPreviousRelease(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at) values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
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
    values ('j-1', 'w-1', 'r-1', -1, 'https://github.test/acme/x/tree/b', ${"a".repeat(40)}, 'review', '', 'manual', 'octocat',
      'queued', ${T}, 0, ${T}, ${T})`.execute(db);
  await sql`insert into implementer_sessions (id, workspace_id, repository_id, slot, base_branch, branch, status, created_by, created_at, updated_at)
    values ('s-1', 'w-1', 'r-1', 1, 'main', 'b', 'running', 'u-1', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into implementer_turns (id, session_id, workspace_id, number, instruction, model_choice, job_id, created_by, created_at)
    values ('t-1', 's-1', 'w-1', 1, 'do it', '{"entryId":"e"}', 'j-1', 'u-1', ${T})`.execute(
    db,
  );
}

describe("the migration that adds the queued instruction", () => {
  // #841-M01
  it("adds four nullable columns to a database with data, changes no existing row, and every old session reads null", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, before);
    await seedPreviousRelease(db);
    const tables = await tableNames(db);
    const rows = await rowsOf(db, tables);

    const { executed } = await migrateToLatest(db, migrationProvider);

    expect(executed).toContain(THIS);
    expect(await rowsOf(db, tables)).toEqual(rows);
    const { rows: sessions } = await sql<{
      queued_instruction: string | null;
      queued_discarded: string | null;
      queued_attempted_at: string | null;
      queued_first_failed_at: string | null;
    }>`select queued_instruction, queued_discarded, queued_attempted_at, queued_first_failed_at from implementer_sessions`.execute(
      db,
    );
    expect(sessions).toEqual([
      {
        queued_instruction: null,
        queued_discarded: null,
        queued_attempted_at: null,
        queued_first_failed_at: null,
      },
    ]);
    await db.destroy();
  });

  // #841-M02
  it("is applied once, and adds no table, index or foreign key", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, before);
    const tables = await tableNames(db);
    const { rows: indexesBefore } = await sql<{
      indexname: string;
    }>`select indexname from pg_indexes where schemaname = current_schema() order by indexname`.execute(
      db,
    );

    await migrateToLatest(db, throughThis);

    expect((await migrateToLatest(db, throughThis)).executed).toEqual([]);
    expect(await tableNames(db)).toEqual(tables);
    const { rows: indexesAfter } = await sql<{
      indexname: string;
    }>`select indexname from pg_indexes where schemaname = current_schema() order by indexname`.execute(
      db,
    );
    expect(indexesAfter).toEqual(indexesBefore);
    await db.destroy();
  });

  // #841-M03
  it("keeps a text out that is larger than any real queued instruction", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seedPreviousRelease(db);

    await sql`update implementer_sessions set queued_instruction = '{}', queued_discarded = '{}', queued_attempted_at = '2026-11-05T00:00:00.000Z', queued_first_failed_at = '2026-11-05T00:00:00.000Z'`.execute(
      db,
    );
    for (const [column, size] of [
      ["queued_instruction", 524_289],
      ["queued_discarded", 524_289],
      ["queued_attempted_at", 65],
      ["queued_first_failed_at", 65],
    ] as const)
      await expect(
        sql`update implementer_sessions set ${sql.ref(column)} = ${"x".repeat(size)}`.execute(
          db,
        ),
      ).rejects.toThrow(/implementer_sessions_queue_check/);
    await db.destroy();
  });

  // #841-M04
  it("keeps the lock timeout it sets to itself", async () => {
    const { db } = await createEmptyTestDatabase({ poolMax: 1 });
    const seen: string[] = [];
    const withProbe: MigrationProvider = {
      async getMigrations() {
        return {
          ...(await migrationProvider.getMigrations()),
          "99999999999999_probe_lock_timeout": {
            async up(trx) {
              const { rows } = await sql<{
                value: string;
              }>`select current_setting('lock_timeout') as value`.execute(trx);
              seen.push(rows[0]?.value ?? "");
            },
          },
        };
      },
    };

    await migrateToLatest(db, withProbe);

    expect(seen).toEqual(["0"]);
    await db.destroy();
  });

  // #841-M05
  it("gives up with MIGRATION_FAILED and leaves nothing half applied when a writer keeps the sessions locked, then succeeds once it is gone", async () => {
    const { db, url } = await createEmptyTestDatabase();
    await migrateToLatest(db, before);
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
    // A transaction that has written a row of the table and does not end: `add column` has to wait for it.
    const writerDone = writer.transaction().execute(async (trx) => {
      await sql`update implementer_sessions set base_branch = 'main'`.execute(
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

    expect(Date.now() - startedAt).toBeLessThan(20_000);
    const { rows } = await sql<{
      count: number;
    }>`select count(*)::int as count from information_schema.columns
          where table_name = 'implementer_sessions' and column_name like 'queued_%'`.execute(
      db,
    );
    expect(rows).toEqual([{ count: 0 }]);
    release();
    await writerDone;
    await expect(migrateToLatest(db, migrationProvider)).resolves.toMatchObject(
      { executed: expect.arrayContaining([THIS]) },
    );
    await writer.destroy();
    await db.destroy();
  }, 40_000);
});
