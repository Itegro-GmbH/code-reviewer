// SPDX-License-Identifier: LicenseRef-Proprietary

// #745: the steps migration is expand only. It adds one empty table (and an index of its own) to a database made by the previous
// release's migrations, changes no existing row and no existing table, and gives up loudly instead of making a writer wait when
// a lock on a table it points at is held.
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

const THIS = "20261104100000_create_implementer_turn_steps";
const T = "2026-11-04T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

/** The migrations up to and including this one: a later migration adds columns to tables this one leaves alone. */
const throughThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name <= THIS,
      ),
    );
  },
};

async function rowsOfEveryOldTable(
  db: Kysely<Database>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (table.name === "implementer_turn_steps") continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)} order by 1`.execute(
        db,
      );
    result[table.name] = withoutColumnsAddedLater(table.name, rows);
  }
  return result;
}

async function columnsOfEveryOldTable(
  db: Kysely<Database>,
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (table.name === "implementer_turn_steps") continue;
    result[table.name] = table.columns.map((column) => column.name).sort();
  }
  return result;
}

async function seedPreviousRelease(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
    db,
  );
}

describe("the implementer turn steps migration", () => {
  // #745-T01
  it("adds one empty table to an existing database with data and changes no existing row or table", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seedPreviousRelease(db);
    const before = await rowsOfEveryOldTable(db);
    const columnsBefore = await columnsOfEveryOldTable(db);

    const { executed } = await migrateToLatest(db, throughThisMigration);

    expect(executed).toContain(THIS);
    expect(await rowsOfEveryOldTable(db)).toEqual(before);
    expect(await columnsOfEveryOldTable(db)).toEqual(columnsBefore);
    const { rows } = await sql<{
      count: number;
    }>`select count(*)::int as count from implementer_turn_steps`.execute(db);
    expect(rows).toEqual([{ count: 0 }]);
    await db.destroy();
  });

  // #745-T01
  it("is applied once: running it again applies nothing", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const again = await migrateToLatest(db, migrationProvider);

    expect(again.executed).toEqual([]);
    await db.destroy();
  });

  // #745-T01
  it("has the key (job, part), an index for reading after a seq, and a composite key to jobs", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const constraints = await sql<{
      conname: string;
      definition: string;
    }>`select conname, pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'implementer_turn_steps'::regclass order by conname`.execute(
      db,
    );
    const byName = Object.fromEntries(
      constraints.rows.map((row) => [row.conname, row.definition]),
    );
    expect(byName["implementer_turn_steps_pkey"]).toBe(
      "PRIMARY KEY (job_id, part_id)",
    );
    expect(byName["implementer_turn_steps_job_fk"]).toBe(
      "FOREIGN KEY (job_id, workspace_id) REFERENCES jobs(id, workspace_id)",
    );
    const indexes = await sql<{
      indexdef: string;
    }>`select indexdef from pg_indexes where tablename = 'implementer_turn_steps'`.execute(
      db,
    );
    expect(indexes.rows.map((row) => row.indexdef)).toContainEqual(
      expect.stringContaining("(job_id, seq)"),
    );
    await db.destroy();
  });

  // #745-T01
  it("refuses a step for a job that is not there, a bad seq and a bad kind", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seedPreviousRelease(db);
    const insert = (values: { seq: number; kind: string }) =>
      sql`insert into implementer_turn_steps (job_id, part_id, workspace_id, seq, ordinal, kind, payload, bytes, created_at, updated_at)
        values ('no-job', 'prt_1', 'w-1', ${values.seq}, 1, ${values.kind}, '{}', 2, ${T}, ${T})`.execute(
        db,
      );

    await expect(insert({ seq: 1, kind: "text" })).rejects.toThrow(
      /implementer_turn_steps_job_fk/,
    );
    await expect(insert({ seq: 0, kind: "text" })).rejects.toThrow(
      /implementer_turn_steps_seq_check/,
    );
    await expect(insert({ seq: 1, kind: "Text; drop" })).rejects.toThrow(
      /implementer_turn_steps_kind_check/,
    );
    await db.destroy();
  });

  // #745-T01
  it("gives up with MIGRATION_FAILED and leaves nothing half applied when a writer keeps workspaces locked, then succeeds once it is gone", async () => {
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
    // A transaction that has written a row of `workspaces` and does not end: the foreign key of the new table has to wait for it.
    const writerDone = writer.transaction().execute(async (trx) => {
      await sql`update workspaces set name = 'renamed' where id = 'w-1'`.execute(
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
    expect(
      (await db.introspection.getTables()).map((entry) => entry.name),
    ).not.toContain("implementer_turn_steps");
    release();
    await writerDone;
    await expect(migrateToLatest(db, migrationProvider)).resolves.toMatchObject(
      { executed: expect.arrayContaining([THIS]) },
    );
    await writer.destroy();
    await db.destroy();
  }, 40_000);
});
