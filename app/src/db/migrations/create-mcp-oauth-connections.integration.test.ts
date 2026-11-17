// SPDX-License-Identifier: LicenseRef-Proprietary

// #1051: the OAuth connections migration is expand only. It adds one empty table to a database made by the previous migrations, changes no
// existing row and no existing column, can be taken back, and the table goes with its server.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const THIS = "20261117140000_create_mcp_oauth_connections";
const T = "2026-11-17T08:00:00.000Z";

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

async function snapshot(
  db: Kysely<Database>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (table.name === "mcp_oauth_connections") continue;
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
  }>`select table_name || '.' || column_name as name
    from information_schema.columns where table_schema = 'public' and table_name <> 'mcp_oauth_connections' order by 1`.execute(
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
  await sql`insert into mcp_servers (id, workspace_id, name, transport, url, auth_kind, created_at, updated_at)
    values ('s-1', 'w-1', 'Notion', 'streamable-http', 'https://mcp.example.com/', 'oauth', ${T}, ${T})`.execute(
    db,
  );
}

describe("the MCP OAuth connections migration", () => {
  // #1051
  it("adds one empty table to an existing database and changes no existing row or column", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    const rows = await snapshot(db);
    const before = await columns(db);

    const { executed } = await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(executed).toContain(THIS);
    expect(await snapshot(db)).toEqual(rows);
    expect(await columns(db)).toEqual(before);
    const { rows: counts } = await sql<{
      n: number;
    }>`select count(*)::int as n from mcp_oauth_connections`.execute(db);
    expect(counts).toEqual([{ n: 0 }]);
    await db.destroy();
  });

  // #1051
  it("is applied once, and can be taken back, leaving the other tables as they were", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    expect((await migrateToLatest(db, migrationProvider)).executed).toEqual([]);
    const before = await columns(db);

    await (await migrationProvider.getMigrations())[THIS]?.down?.(db);

    const { rows } = await sql<{
      name: string;
    }>`select table_name as name from information_schema.tables
      where table_schema = 'public' and table_name = 'mcp_oauth_connections'`.execute(
      db,
    );
    expect(rows).toEqual([]);
    expect(await columns(db)).toEqual(before);
    await db.destroy();
  });

  // #1051
  it("goes with its server, and refuses a row for a server that is not there", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    await sql`insert into mcp_oauth_connections (server_id, workspace_id, created_at, updated_at) values ('s-1', 'w-1', ${T}, ${T})`.execute(
      db,
    );

    await expect(
      sql`insert into mcp_oauth_connections (server_id, workspace_id, created_at, updated_at) values ('nope', 'w-1', ${T}, ${T})`.execute(
        db,
      ),
    ).rejects.toThrow(/foreign key/);
    await sql`delete from mcp_servers where id = 's-1'`.execute(db);

    const { rows } = await sql<{
      n: number;
    }>`select count(*)::int as n from mcp_oauth_connections`.execute(db);
    expect(rows).toEqual([{ n: 0 }]);
    await db.destroy();
  });

  // #1051
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
