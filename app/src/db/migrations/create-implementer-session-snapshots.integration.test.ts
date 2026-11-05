// SPDX-License-Identifier: LicenseRef-Proprietary

// #839: the session snapshot migration is expand only. It adds two empty tables (and an index of its own) to a database made by the
// previous release's migrations, changes no existing row and no existing table, and gives up loudly instead of making a writer wait
// when a lock on a table it points at is held.
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

const THIS = "20261105090000_create_implementer_session_snapshots";
const NEW_TABLES = [
  "implementer_session_snapshots",
  "implementer_session_snapshot_parts",
];
const T = "2026-11-05T08:00:00.000Z";

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
    if (NEW_TABLES.includes(table.name)) continue;
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
    if (NEW_TABLES.includes(table.name)) continue;
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

async function constraintsOf(db: Kysely<Database>, table: string) {
  const constraints = await sql<{
    conname: string;
    definition: string;
  }>`select conname, pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = ${table}::regclass order by conname`.execute(db);
  return Object.fromEntries(
    constraints.rows.map((row) => [row.conname, row.definition]),
  );
}

describe("the implementer session snapshots migration", () => {
  // #839-T20
  it("adds two empty tables to an existing database with data and changes no existing row or table", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seedPreviousRelease(db);
    const before = await rowsOfEveryOldTable(db);
    const columnsBefore = await columnsOfEveryOldTable(db);

    const { executed } = await migrateToLatest(db, throughThisMigration);

    expect(executed).toContain(THIS);
    expect(await rowsOfEveryOldTable(db)).toEqual(before);
    expect(await columnsOfEveryOldTable(db)).toEqual(columnsBefore);
    for (const table of NEW_TABLES) {
      const { rows } = await sql<{
        count: number;
      }>`select count(*)::int as count from ${sql.table(table)}`.execute(db);
      expect(rows).toEqual([{ count: 0 }]);
    }
    await db.destroy();
  });

  // #839-T20
  it("is applied once: running it again applies nothing", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const again = await migrateToLatest(db, migrationProvider);

    expect(again.executed).toEqual([]);
    await db.destroy();
  });

  // #839-T20
  it("keys a snapshot by its session, a part by (job, index), and links both to the session and the job in the same workspace", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const snapshots = await constraintsOf(db, "implementer_session_snapshots");
    expect(snapshots["implementer_session_snapshots_pkey"]).toBe(
      "PRIMARY KEY (session_id)",
    );
    expect(snapshots["implementer_session_snapshots_session_fk"]).toBe(
      "FOREIGN KEY (session_id, workspace_id) REFERENCES implementer_sessions(id, workspace_id)",
    );
    expect(snapshots["implementer_session_snapshots_job_fk"]).toBe(
      "FOREIGN KEY (job_id, workspace_id) REFERENCES jobs(id, workspace_id)",
    );
    const parts = await constraintsOf(db, "implementer_session_snapshot_parts");
    expect(parts["implementer_session_snapshot_parts_pkey"]).toBe(
      "PRIMARY KEY (job_id, part_index)",
    );
    expect(parts["implementer_session_snapshot_parts_session_fk"]).toBe(
      "FOREIGN KEY (session_id, workspace_id) REFERENCES implementer_sessions(id, workspace_id)",
    );
    expect(parts["implementer_session_snapshot_parts_job_fk"]).toBe(
      "FOREIGN KEY (job_id, workspace_id) REFERENCES jobs(id, workspace_id)",
    );
    await db.destroy();
  });

  // #839-T20
  it("refuses a snapshot for a session that is not there and a bad turn, version, size or digest", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seedPreviousRelease(db);
    const insert = (values: {
      turn: number;
      version: string;
      bytes: number;
      sha: string;
    }) =>
      sql`insert into implementer_session_snapshots (session_id, workspace_id, job_id, turn_number, opencode_version, bytes, raw_bytes, sha256, data, created_at, updated_at)
        values ('no-session', 'w-1', 'no-job', ${values.turn}, ${values.version}, ${values.bytes}, 10, ${values.sha}, 'AAAA', ${T}, ${T})`.execute(
        db,
      );
    const good = { turn: 1, version: "1.19.0", bytes: 3, sha: "a".repeat(64) };

    await expect(insert(good)).rejects.toThrow(
      /implementer_session_snapshots_session_fk/,
    );
    await expect(insert({ ...good, turn: 0 })).rejects.toThrow(
      /implementer_session_snapshots_turn_check/,
    );
    await expect(insert({ ...good, version: "1.0; drop" })).rejects.toThrow(
      /implementer_session_snapshots_version_check/,
    );
    await expect(insert({ ...good, bytes: 0 })).rejects.toThrow(
      /implementer_session_snapshots_bytes_check/,
    );
    await expect(insert({ ...good, sha: "XYZ" })).rejects.toThrow(
      /implementer_session_snapshots_sha256_check/,
    );
    await db.destroy();
  });

  // #839-T20
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
    // A transaction that has written a row of `workspaces` and does not end: the foreign key of the new tables has to wait for it.
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
    const names = (await db.introspection.getTables()).map(
      (entry) => entry.name,
    );
    for (const table of NEW_TABLES) expect(names).not.toContain(table);
    release();
    await writerDone;
    await expect(migrateToLatest(db, migrationProvider)).resolves.toMatchObject(
      { executed: expect.arrayContaining([THIS]) },
    );
    await writer.destroy();
    await db.destroy();
  }, 40_000);
});
