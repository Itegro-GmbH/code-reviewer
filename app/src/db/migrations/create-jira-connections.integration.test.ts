// SPDX-License-Identifier: LicenseRef-Proprietary

// #1037: the Jira connections migration is expand only. It adds one empty table to a database made by the previous release's migrations,
// changes no existing row and no existing column, can be taken back, and the table keeps what the code relies on: one connection per
// site and workspace, and a status that agrees with its error code.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const THIS = "20261114160000_create_jira_connections";
const T = "2026-11-14T08:00:00.000Z";

function upTo(include: (name: string) => boolean): MigrationProvider {
  return {
    async getMigrations() {
      return Object.fromEntries(
        Object.entries(await migrationProvider.getMigrations()).filter(
          ([name]) => include(name),
        ),
      );
    },
  };
}
const beforeThisMigration = upTo((name) => name < THIS);
const throughThisMigration = upTo((name) => name <= THIS);

async function snapshot(
  db: Kysely<Database>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (table.name === "jira_connections" || table.name === "jira_webhooks")
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
    where table_schema = 'public' and table_name not in ('jira_connections', 'jira_webhooks') order by 1`.execute(
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

const connection = (
  id: string,
  change: Partial<Record<string, string | null>> = {},
) => {
  const v = {
    cloud_id: "cloud-1",
    status: "connected",
    error_code: null,
    ...change,
  };
  return sql`insert into jira_connections (id, workspace_id, cloud_id, site_url, site_name, account_id, account_name, scopes, status,
      error_code, tokens_ciphertext, tokens_nonce, tokens_key_version, access_expires_at, created_at, updated_at)
    values (${id}, 'w-1', ${v.cloud_id}, 'https://acme.atlassian.net', 'acme', 'a-1', 'Ada', 'read:jira-work', ${v.status},
      ${v.error_code}, 'c', 'n', 1, ${T}, ${T}, ${T})`;
};

describe("the Jira connections migration", () => {
  // #1037
  it("adds one empty table to an existing database and changes no existing row or column", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seed(db);
    const rows = await snapshot(db);
    const before = await columns(db);

    const { executed } = await migrateToLatest(db, throughThisMigration);

    expect(executed).toContain(THIS);
    expect(await snapshot(db)).toEqual(rows);
    expect(await columns(db)).toEqual(before);
    const { rows: counts } = await sql<{
      n: number;
    }>`select count(*)::int as n from jira_connections`.execute(db);
    expect(counts).toEqual([{ n: 0 }]);
    await db.destroy();
  });

  // #1037
  it("is applied once, and can be taken back, leaving the other tables as they were", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    expect((await migrateToLatest(db, migrationProvider)).executed).toEqual([]);
    const before = await columns(db);

    // The webhooks of #1039 point at the connections: they go first, as the later migration comes off before this one.
    const migrations = await migrationProvider.getMigrations();
    await migrations["20261114180000_create_jira_webhooks"]?.down?.(db);
    await migrations[THIS]?.down?.(db);

    const { rows } = await sql<{
      name: string;
    }>`select table_name as name from information_schema.tables
      where table_schema = 'public' and table_name like 'jira%'`.execute(db);
    expect(rows).toEqual([]);
    expect(await columns(db)).toEqual(before);
    await db.destroy();
  });

  // #1037
  it("keeps one connection per site and workspace, and a status that agrees with its error code", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    await connection("jc-1").execute(db);

    await expect(connection("jc-2").execute(db)).rejects.toThrow(
      /jira_connections_workspace_site_unique/,
    );
    await expect(
      connection("jc-3", { cloud_id: "cloud-3", status: "odd" }).execute(db),
    ).rejects.toThrow(/jira_connections_status_check/);
    await expect(
      connection("jc-4", { cloud_id: "cloud-4", status: "broken" }).execute(db),
    ).rejects.toThrow(/jira_connections_error_check/);
    await expect(
      connection("jc-5", {
        cloud_id: "cloud-5",
        error_code: "jira_refresh_refused",
      }).execute(db),
    ).rejects.toThrow(/jira_connections_error_check/);
    await connection("jc-6", {
      cloud_id: "cloud-6",
      status: "broken",
      error_code: "jira_refresh_refused",
    }).execute(db);
    await db.destroy();
  });

  // #1037
  it("keeps the lock timeout it sets to itself: a later migration of the same batch does not inherit it", async () => {
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
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await migrateToLatest(db, withProbe);
    expect(seen).toEqual(["0"]);
    await db.destroy();
  });
});
