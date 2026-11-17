// SPDX-License-Identifier: LicenseRef-Proprietary

// #1050: the MCP servers migration is expand only. It adds one empty table to a database made by the previous migrations, changes no existing
// row and no existing column, can be taken back, and the table keeps what the code relies on: one server per name (any case) and workspace,
// a transport and an authentication of the list, sealed headers exactly for the kind `header`, and a test status that agrees with its error code.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const THIS = "20261117100000_create_mcp_servers";
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
    if (table.name === "mcp_servers") continue;
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
    from information_schema.columns where table_schema = 'public' and table_name <> 'mcp_servers' order by 1`.execute(
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

const row = (
  id: string,
  change: Record<string, string | number | null> = {},
) => {
  const v = {
    name: id,
    transport: "streamable-http",
    auth_kind: "none",
    header_names: null,
    headers_ciphertext: null,
    headers_nonce: null,
    headers_key_version: null,
    test_status: "untested",
    tested_at: null,
    test_error_code: null,
    ...change,
  };
  return sql`insert into mcp_servers (id, workspace_id, name, transport, url, auth_kind, header_names, headers_ciphertext, headers_nonce,
      headers_key_version, test_status, tested_at, test_error_code, created_at, updated_at)
    values (${id}, 'w-1', ${v.name}, ${v.transport}, 'https://mcp.example.com/', ${v.auth_kind}, ${v.header_names}, ${v.headers_ciphertext},
      ${v.headers_nonce}, ${v.headers_key_version}, ${v.test_status}, ${v.tested_at}, ${v.test_error_code}, ${T}, ${T})`;
};

describe("the MCP servers migration", () => {
  // #1050
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
    }>`select count(*)::int as n from mcp_servers`.execute(db);
    expect(counts).toEqual([{ n: 0 }]);
    await db.destroy();
  });

  // #1050
  it("is applied once, and can be taken back, leaving the other tables as they were", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    expect((await migrateToLatest(db, migrationProvider)).executed).toEqual([]);
    const before = await columns(db);

    await (await migrationProvider.getMigrations())[THIS]?.down?.(db);

    const { rows } = await sql<{
      name: string;
    }>`select table_name as name from information_schema.tables
      where table_schema = 'public' and table_name = 'mcp_servers'`.execute(db);
    expect(rows).toEqual([]);
    expect(await columns(db)).toEqual(before);
    await db.destroy();
  });

  // #1050
  it("keeps one server per name whatever its case, a known transport and authentication, and sealed headers exactly for the kind header", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    await row("s-1", { name: "Linear" }).execute(db);

    await expect(row("s-2", { name: "linear" }).execute(db)).rejects.toThrow(
      /mcp_servers_workspace_name_unique/,
    );
    await expect(
      row("s-3", { transport: "stdio" }).execute(db),
    ).rejects.toThrow(/mcp_servers_transport_check/);
    await expect(
      row("s-4", { auth_kind: "basic" }).execute(db),
    ).rejects.toThrow(/mcp_servers_auth_check/);
    // `oauth` is reserved: the column accepts it (#1051), without sealed headers.
    await row("s-5", { auth_kind: "oauth" }).execute(db);
    await expect(
      row("s-6", { auth_kind: "header" }).execute(db),
    ).rejects.toThrow(/mcp_servers_headers_check/);
    await expect(
      row("s-7", {
        headers_ciphertext: "c",
        headers_nonce: "n",
        headers_key_version: 1,
      }).execute(db),
    ).rejects.toThrow(/mcp_servers_headers_check/);
    await row("s-8", {
      auth_kind: "header",
      header_names: '["Authorization"]',
      headers_ciphertext: "c",
      headers_nonce: "n",
      headers_key_version: 1,
    }).execute(db);
    await db.destroy();
  });

  // #1050
  it("keeps a test status that agrees with its error code and its time", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await expect(
      row("s-1", { test_status: "odd" }).execute(db),
    ).rejects.toThrow(/mcp_servers_test_check/);
    await expect(
      row("s-2", { test_status: "failed", tested_at: T }).execute(db),
    ).rejects.toThrow(/mcp_servers_test_check/);
    await expect(
      row("s-3", {
        test_status: "ok",
        tested_at: T,
        test_error_code: "mcp_test_timeout",
      }).execute(db),
    ).rejects.toThrow(/mcp_servers_test_check/);
    await expect(row("s-4", { test_status: "ok" }).execute(db)).rejects.toThrow(
      /mcp_servers_test_check/,
    );
    await row("s-5", { test_status: "ok", tested_at: T }).execute(db);
    await row("s-6", {
      test_status: "failed",
      tested_at: T,
      test_error_code: "mcp_test_timeout",
    }).execute(db);
    await db.destroy();
  });

  // #1050
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
