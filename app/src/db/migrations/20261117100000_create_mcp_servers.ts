// SPDX-License-Identifier: LicenseRef-Proprietary

// The MCP servers of a workspace (#1050, epic #1049: MCP servers for agents). One row is one remote MCP server a workspace added: where it is
// (`url`), how to talk to it (`transport`: Streamable HTTP or SSE), how to authenticate (`auth_kind`), and what the last connection test found.
//
// Authentication. `none`, or `header`: one or more request headers (a bearer token, an API key) kept as ONE JSON text, sealed with AES-256-GCM
// like every other credential (`src/crypto/secret-box.ts`: the table, the row id and the field `headers` are bound into the ciphertext), in
// three columns of the row. `header_names` holds the names only (not secret), so a page can list a header with a mask without opening the
// seal. The check constraints make the two agree: a sealed value exists exactly when the kind is `header`. `oauth` is RESERVED for #1051 (the
// authorization spec: discovery, dynamic client registration, PKCE, refresh): the kind is accepted by the column and refused by the registry
// until then. Its tokens and client registration will live in a table of their own, keyed by `mcp_servers.id` (#1051 adds it), so this table
// needs no rewrite and no nullable OAuth columns. A catalog preset (#1054) is only a prefilled form: it adds nothing here.
//
// The last test. `test_status` is `untested` (no test yet, or the address, the transport or the credentials changed since), `ok` or `failed`;
// `test_error_code` is a stable code of `src/mcp/errors.ts` and agrees with the status (`mcp_servers_test_check`). `tools_snapshot` is the JSON
// of what the last SUCCESSFUL test listed (server name and version, protocol version, the tools with name and description, whether the list was
// cut); it stays after a later failed test, so the page can still show what the server offered. `revision` counts the changes of the
// configuration: a test result is stored only for the revision that was tested, so an edit made while a test ran is not overwritten by a
// result about the old address.
//
// One workspace has one server of a name, whatever its case (`mcp_servers_workspace_name_unique`).
//
// Expand only, safe for the version that is still running (it never reads the table) and for the live database: one new table, no column,
// row or index of an existing table changes. The foreign keys take a short lock on `workspaces` and `users`; the wait is bounded: after
// `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again.
// `down` drops the table.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** How long the migration waits for a lock before it gives up. */
export const LOCK_TIMEOUT = "5s";

export const migration: Migration = {
  async up(db) {
    // `set local` ends with the transaction, but the migrations after this one in the same batch run in it too: put back what was set.
    const { rows } = await sql<{
      value: string;
    }>`select current_setting('lock_timeout') as value`.execute(db);
    const before = rows[0]?.value ?? "0";
    await sql`set local lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(db);

    await db.schema
      .createTable("mcp_servers")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("transport", "text", (column) => column.notNull())
      .addColumn("url", "text", (column) => column.notNull())
      .addColumn("auth_kind", "text", (column) => column.notNull())
      // The names of the sealed headers as a JSON array, in the order the person gave them; null unless the kind is `header`.
      .addColumn("header_names", "text")
      .addColumn("headers_ciphertext", "text")
      .addColumn("headers_nonce", "text")
      .addColumn("headers_key_version", "integer")
      .addColumn("revision", "integer", (column) =>
        column.notNull().defaultTo(1),
      )
      .addColumn("test_status", "text", (column) =>
        column.notNull().defaultTo("untested"),
      )
      .addColumn("tested_at", "text")
      .addColumn("test_error_code", "text")
      .addColumn("tools_snapshot", "text")
      .addColumn("created_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "mcp_servers_transport_check",
        sql`transport in ('streamable-http', 'sse')`,
      )
      .addCheckConstraint(
        "mcp_servers_auth_check",
        sql`auth_kind in ('none', 'header', 'oauth')`,
      )
      .addCheckConstraint(
        "mcp_servers_headers_check",
        sql`(auth_kind = 'header') = (headers_ciphertext is not null)
          and (headers_ciphertext is null) = (headers_nonce is null)
          and (headers_ciphertext is null) = (headers_key_version is null)
          and (auth_kind = 'header') = (header_names is not null)`,
      )
      .addCheckConstraint(
        "mcp_servers_test_check",
        sql`test_status in ('untested', 'ok', 'failed')
          and (test_status = 'failed') = (test_error_code is not null)
          and (test_status = 'untested') = (tested_at is null)`,
      )
      .execute();
    await sql`create unique index mcp_servers_workspace_name_unique
      on mcp_servers (workspace_id, lower(name))`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("mcp_servers").execute();
  },
};
