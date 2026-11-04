// SPDX-License-Identifier: LicenseRef-Proprietary

// #833: the workflows migration is expand only. It adds two empty tables to a database made by the previous release's migrations
// (the live one has jobs and implementer rows), changes no existing row and no existing table, and can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const THIS = "20261104140000_create_workflows";
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

async function snapshot(
  db: Kysely<Database>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    // The workflow tables are this migration's; the profile tables (#843) are a later migration's and empty.
    if (
      table.name === "workflows" ||
      table.name === "workflow_versions" ||
      table.name === "profiles" ||
      table.name === "profile_versions"
    )
      continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)} order by 1`.execute(
        db,
      );
    result[table.name] = withoutColumnsAddedLater(table.name, rows);
  }
  return result;
}

async function columns(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{
    name: string;
  }>`select table_name || '.' || column_name as name from information_schema.columns
    where table_schema = 'public' and table_name not in ('workflows', 'workflow_versions', 'profiles', 'profile_versions')
    and not (table_name = 'implementer_turns' and column_name like 'profile\_%') order by 1`.execute(
    db,
  );
  return rows.map((row) => row.name);
}

async function seed(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
    db,
  );
}

describe("the workflows migration", () => {
  // #833-M1-T170
  it("adds two empty tables to an existing database and changes no existing row or column", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seed(db);
    const rows = await snapshot(db);
    const before = await columns(db);

    const { executed } = await migrateToLatest(db, migrationProvider);

    expect(executed).toContain(THIS);
    expect(await snapshot(db)).toEqual(rows);
    expect(await columns(db)).toEqual(before);
    const { rows: counts } = await sql<{
      workflows: number;
      versions: number;
    }>`select (select count(*) from workflows)::int as workflows, (select count(*) from workflow_versions)::int as versions`.execute(
      db,
    );
    expect(counts).toEqual([{ workflows: 0, versions: 0 }]);
    await db.destroy();
  });

  // #833-M1-T171
  it("is applied once: running it again applies nothing", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    expect((await migrateToLatest(db, migrationProvider)).executed).toEqual([]);
    await db.destroy();
  });

  // #833-M1-T172
  it("can be taken back, leaving the other tables as they were", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    const before = await columns(db);

    await (await migrationProvider.getMigrations())[THIS]?.down?.(db);

    const { rows } = await sql<{
      name: string;
    }>`select table_name as name from information_schema.tables
      where table_schema = 'public' and table_name like 'workflow%'`.execute(
      db,
    );
    expect(rows).toEqual([]);
    expect(await columns(db)).toEqual(before);
    await db.destroy();
  });

  // #833-M1-T173
  it("keeps a name once per workspace whatever its case, and the version numbers positive", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    await sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
      values ('f-1', 'w-1', 'Flow', 1, 'u-1', ${T}, ${T})`.execute(db);

    await expect(
      sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
        values ('f-1b', 'w-1', 'flow', 1, 'u-1', ${T}, ${T})`.execute(db),
    ).rejects.toThrow(/workflows_workspace_name_unique/);
    await sql`update workflows set archived_at = ${T} where id = 'f-1'`.execute(
      db,
    );
    // An archived workflow gives its name back.
    await sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
      values ('f-2', 'w-1', 'flow', 1, 'u-1', ${T}, ${T})`.execute(db);
    await expect(
      sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
        values ('f-2b', 'w-1', 'FLOW', 1, 'u-1', ${T}, ${T})`.execute(db),
    ).rejects.toThrow(/workflows_workspace_name_unique/);
    await expect(
      sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
        values ('f-3', 'w-1', '', 1, 'u-1', ${T}, ${T})`.execute(db),
    ).rejects.toThrow(/workflows_name_check/);
    await expect(
      sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
        values ('f-4', 'w-1', 'x', 0, 'u-1', ${T}, ${T})`.execute(db),
    ).rejects.toThrow(/workflows_current_version_check/);
    await db.destroy();
  });

  // #833-M1-T174
  it("keeps the lock timeout it sets to itself: a later migration of the same batch does not inherit it", async () => {
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
});
