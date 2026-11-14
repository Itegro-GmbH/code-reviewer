// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira Cloud connections of a workspace (#1037, epic #1034: Jira Cloud as a ticket source). One row is one OAuth 2.0 (3LO) grant of the
// factory's Atlassian app to one Jira site: the site (`cloud_id`, `site_url`, `site_name`), the Atlassian account that granted it, the
// scopes Atlassian reported, and the sealed token pair.
//
// The tokens are one JSON text sealed with AES-256-GCM like every other credential (`src/crypto/secret-box.ts`: the table, the row id and the
// field `tokens` are bound into the ciphertext), in three columns of the row itself, so a refresh replaces access and refresh token in ONE
// statement (Atlassian rotates the refresh token on every refresh: a pair half written would lose the grant). `token_version` counts the
// writes of the pair; a refresh only replaces the version it read (compare and swap), so two requests that refresh at once cannot overwrite
// each other's pair. `access_expires_at` is not secret and lets the code decide whether a refresh is due without decrypting.
//
// `status` is `connected` or `broken`; a broken connection has a stable `error_code` (the refresh was refused, or the tokens cannot be read
// any more) and is mended by connecting again. The two always agree (`jira_connections_error_check`). One workspace has one connection per
// site (unique `(workspace_id, cloud_id)`); connecting a site again is a reconnect of that row.
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
      .createTable("jira_connections")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("cloud_id", "text", (column) => column.notNull())
      .addColumn("site_url", "text", (column) => column.notNull())
      .addColumn("site_name", "text", (column) => column.notNull())
      .addColumn("account_id", "text", (column) => column.notNull())
      .addColumn("account_name", "text", (column) => column.notNull())
      // The scopes Atlassian granted, separated by a space.
      .addColumn("scopes", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("error_code", "text")
      .addColumn("tokens_ciphertext", "text", (column) => column.notNull())
      .addColumn("tokens_nonce", "text", (column) => column.notNull())
      .addColumn("tokens_key_version", "integer", (column) => column.notNull())
      .addColumn("token_version", "integer", (column) =>
        column.notNull().defaultTo(1),
      )
      .addColumn("access_expires_at", "text", (column) => column.notNull())
      .addColumn("connected_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "jira_connections_status_check",
        sql`status in ('connected', 'broken')`,
      )
      .addCheckConstraint(
        "jira_connections_error_check",
        sql`(status = 'broken') = (error_code is not null)`,
      )
      .execute();
    await sql`create unique index jira_connections_workspace_site_unique
      on jira_connections (workspace_id, cloud_id)`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("jira_connections").execute();
  },
};
