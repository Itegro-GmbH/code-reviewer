// SPDX-License-Identifier: LicenseRef-Proprietary

// #818: the environments migration is expand only. It adds one empty table to a database made by the previous release's
// migrations (the live one has jobs and implementer rows), changes no existing row and no existing table, and gives up loudly
// instead of making a writer wait when a lock on a table it points at is held.
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

const THIS = "20261102140000_create_implementer_environments";
const T = "2026-11-02T08:00:00.000Z";

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
    if (table.name === "implementer_environments") continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)} order by 1`.execute(
        db,
      );
    result[table.name] = withoutColumnsAddedLater(table.name, rows);
  }
  return result;
}

async function seedPreviousRelease(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
    db,
  );
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-2', 'other', 'other', 'u-1', ${T})`.execute(
    db,
  );
}

async function insertEnvironment(
  db: Kysely<Database>,
  values: { id: string; workspace: string; name: string; vcpus?: number },
) {
  await sql`insert into implementer_environments (id, workspace_id, name, vcpus, setup_script, created_by, created_at, updated_at)
    values (${values.id}, ${values.workspace}, ${values.name}, ${values.vcpus ?? 2}, '', 'u-1', ${T}, ${T})`.execute(
    db,
  );
}

describe("the implementer environments migration", () => {
  // #818-T02
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
    }>`select count(*)::int as count from implementer_environments`.execute(db);
    expect(rows).toEqual([{ count: 0 }]);
    await db.destroy();
  });

  // #818-T02
  it("is applied once: running it again applies nothing", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const again = await migrateToLatest(db, migrationProvider);

    expect(again.executed).toEqual([]);
    await db.destroy();
  });

  // #818-T02
  it("keeps the names of a workspace apart from the lower case of each other, and apart between workspaces", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seedPreviousRelease(db);
    await insertEnvironment(db, { id: "e-1", workspace: "w-1", name: "Node" });

    await expect(
      insertEnvironment(db, { id: "e-2", workspace: "w-1", name: "node" }),
    ).rejects.toThrow(/implementer_environments_workspace_name_unique/);
    await insertEnvironment(db, { id: "e-3", workspace: "w-2", name: "Node" });
    await db.destroy();
  });

  // #818-T02
  it("refuses a size below one vCPU, an empty name and a script over 64 KB; it stores the script as it is", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seedPreviousRelease(db);

    await expect(
      insertEnvironment(db, {
        id: "e-1",
        workspace: "w-1",
        name: "x",
        vcpus: 0,
      }),
    ).rejects.toThrow(/implementer_environments_vcpus_check/);
    await expect(
      insertEnvironment(db, { id: "e-2", workspace: "w-1", name: "" }),
    ).rejects.toThrow(/implementer_environments_name_check/);
    await expect(
      sql`insert into implementer_environments (id, workspace_id, name, vcpus, setup_script, created_by, created_at, updated_at)
        values ('e-3', 'w-1', 'big', 2, ${"x".repeat(65537)}, 'u-1', ${T}, ${T})`.execute(
        db,
      ),
    ).rejects.toThrow(/implementer_environments_setup_script_check/);

    const script = "  npm ci\r\n\techo 'x'   \n";
    await sql`insert into implementer_environments (id, workspace_id, name, vcpus, setup_script, created_by, created_at, updated_at)
      values ('e-4', 'w-1', 'ok', 2, ${script}, 'u-1', ${T}, ${T})`.execute(db);
    const { rows } = await sql<{
      setup_script: string;
    }>`select setup_script from implementer_environments where id = 'e-4'`.execute(
      db,
    );
    expect(rows[0]?.setup_script).toBe(script);
    await db.destroy();
  });

  // #818-T02
  it("refuses an environment of a workspace that does not exist", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seedPreviousRelease(db);

    await expect(
      insertEnvironment(db, { id: "e-1", workspace: "nope", name: "x" }),
    ).rejects.toThrow(/foreign key/);
    await db.destroy();
  });

  // #818-T02
  it("keeps the lock timeout it sets to itself: a later migration of the same batch and the session do not inherit it", async () => {
    const { db } = await createEmptyTestDatabase({ poolMax: 1 });
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
    ).toBeGreaterThan(executed.indexOf(THIS));
    expect(seenByLaterMigration).toEqual(["0"]);
    await db.destroy();
  });

  // #818-T02
  it.each(["users", "workspaces"])(
    "gives up with MIGRATION_FAILED and leaves nothing half applied when a writer keeps %s locked, then succeeds once it is gone",
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
      // A transaction that has written a row of the table and does not end: the foreign key of the new table has to wait for it.
      const writerDone = writer.transaction().execute(async (trx) => {
        await WRITE_TO[table]!(trx);
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
        (await db.introspection.getTables()).map((entry) => entry.name),
      ).not.toContain("implementer_environments");
      release();
      await writerDone;
      await expect(
        migrateToLatest(db, migrationProvider),
      ).resolves.toMatchObject({ executed: expect.arrayContaining([THIS]) });
      await writer.destroy();
      await db.destroy();
    },
    40_000,
  );

  // #818-T02
  it("never locks jobs: a write to jobs does not wait while the migration waits for a writer on users", async () => {
    const { db, url } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seedPreviousRelease(db);
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
    const writerDone = writer.transaction().execute(async (trx) => {
      await WRITE_TO["users"]!(trx);
      started();
      await held;
    });
    await writing;

    const migrating = migrateToLatest(db, migrationProvider);
    await waitUntilBlocked(queue);
    const startedAt = Date.now();
    const write = await queue
      .transaction()
      .execute(async (trx) => {
        await sql`set local lock_timeout = '1500ms'`.execute(trx);
        await sql`select id from jobs for update`.execute(trx);
        return { waitedMs: Date.now() - startedAt };
      })
      .catch((error: unknown) => ({ failed: String(error) }));
    release();
    await writerDone;
    await migrating.then(
      () => undefined,
      () => undefined,
    );

    expect(write).toEqual({ waitedMs: expect.any(Number) });
    expect((write as { waitedMs: number }).waitedMs).toBeLessThan(1_000);
    await queue.destroy();
    await writer.destroy();
    await db.destroy();
  }, 40_000);
});

const WRITE_TO: Record<string, (trx: Kysely<Database>) => Promise<unknown>> = {
  users: (trx) =>
    sql`update users set name = 'renamed' where id = 'u-1'`.execute(trx),
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

async function columnsOfEveryOldTable(
  db: Kysely<Database>,
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (table.name === "implementer_environments") continue;
    result[table.name] = table.columns.map((column) => column.name).sort();
  }
  return result;
}
