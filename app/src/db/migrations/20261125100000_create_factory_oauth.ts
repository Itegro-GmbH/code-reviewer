// SPDX-License-Identifier: LicenseRef-Proprietary

// The OAuth server of the factory MCP (#1144, epic #1143): five new tables, nothing existing changes.
//
// - `factory_oauth_clients`: the AI apps that registered themselves (RFC 7591), before any workspace is known. Public clients only: no
//   secret exists. Instance level, not customer data; the table is bounded in code (a client nobody authorized goes after a day).
// - `factory_oauth_requests`: an authorization request that waits for the person's consent (10 minutes); it carries the PKCE challenge.
//   Instance level (no workspace is chosen yet), deleted when it is answered or expires.
// - `factory_oauth_grants`: what a person approved: one workspace, one scope, one client. **Customer data, workspace scoped**
//   (`factory-oauth-repository.ts`); the "Connected AI apps" list is this table. `connected_at` is set when the code was exchanged;
//   a grant without it is cleaned up. `revoked_at` ends the grant (its codes and tokens are deleted). A row goes with its user.
// - `factory_oauth_codes`: the authorization code, single use, 60 seconds; only the SHA-256 is kept.
// - `factory_oauth_tokens`: the access token (15 minutes) and the refresh token (rotating, 30 days idle, 90 days at most) of a grant;
//   only the SHA-256 is kept, so a copy of the table is no credential. `used_at` marks a spent refresh token (reuse detection).
//   Codes and tokens belong to the grant (`on delete cascade`) and carry its `workspace_id` so a lookup by hash answers the workspace.
//
// Expand only, safe for the version that is still running (it never reads these tables) and for the live database. The foreign keys take
// a short lock on `users` and `workspaces`; the wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled
// back (`MIGRATION_FAILED`) and the deployment can be run again. `down` drops the tables.
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
      .createTable("factory_oauth_clients")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("name", "text", (column) => column.notNull())
      // JSON text: the list of registered redirect URIs.
      .addColumn("redirect_uris", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("factory_oauth_requests")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("client_id", "text", (column) =>
        column.notNull().references("factory_oauth_clients.id").onDelete("cascade"),
      )
      .addColumn("redirect_uri", "text", (column) => column.notNull())
      .addColumn("state", "text")
      .addColumn("code_challenge", "text", (column) => column.notNull())
      // The scopes the client asked for, separated by a space; empty when it named none.
      .addColumn("scope", "text", (column) => column.notNull())
      .addColumn("resource", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .execute();
    await db.schema
      .createIndex("factory_oauth_requests_expires")
      .on("factory_oauth_requests")
      .column("expires_at")
      .execute();

    await db.schema
      .createTable("factory_oauth_grants")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("user_id", "text", (column) =>
        column.notNull().references("users.id").onDelete("cascade"),
      )
      .addColumn("client_id", "text", (column) =>
        column.notNull().references("factory_oauth_clients.id").onDelete("cascade"),
      )
      // What the person approved, separated by a space: one scope.
      .addColumn("scope", "text", (column) => column.notNull())
      .addColumn("resource", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("connected_at", "text")
      .addColumn("last_used_at", "text")
      .addColumn("revoked_at", "text")
      .addCheckConstraint(
        "factory_oauth_grants_scope_check",
        sql`scope in ('factory:read', 'factory:control')`,
      )
      .execute();
    await db.schema
      .createIndex("factory_oauth_grants_workspace")
      .on("factory_oauth_grants")
      .columns(["workspace_id", "revoked_at"])
      .execute();
    await db.schema
      .createIndex("factory_oauth_grants_client")
      .on("factory_oauth_grants")
      .column("client_id")
      .execute();

    await db.schema
      .createTable("factory_oauth_codes")
      .addColumn("code_hash", "text", (column) => column.primaryKey())
      .addColumn("grant_id", "text", (column) =>
        column.notNull().references("factory_oauth_grants.id").onDelete("cascade"),
      )
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("client_id", "text", (column) => column.notNull())
      .addColumn("redirect_uri", "text", (column) => column.notNull())
      .addColumn("code_challenge", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("used_at", "text")
      .execute();
    await db.schema
      .createIndex("factory_oauth_codes_grant")
      .on("factory_oauth_codes")
      .column("grant_id")
      .execute();

    await db.schema
      .createTable("factory_oauth_tokens")
      .addColumn("token_hash", "text", (column) => column.primaryKey())
      .addColumn("grant_id", "text", (column) =>
        column.notNull().references("factory_oauth_grants.id").onDelete("cascade"),
      )
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("kind", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("used_at", "text")
      .addCheckConstraint(
        "factory_oauth_tokens_kind_check",
        sql`kind in ('access', 'refresh')`,
      )
      .execute();
    await db.schema
      .createIndex("factory_oauth_tokens_grant")
      .on("factory_oauth_tokens")
      .column("grant_id")
      .execute();
    await db.schema
      .createIndex("factory_oauth_tokens_expires")
      .on("factory_oauth_tokens")
      .column("expires_at")
      .execute();

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("factory_oauth_tokens").execute();
    await db.schema.dropTable("factory_oauth_codes").execute();
    await db.schema.dropTable("factory_oauth_grants").execute();
    await db.schema.dropTable("factory_oauth_requests").execute();
    await db.schema.dropTable("factory_oauth_clients").execute();
  },
};
