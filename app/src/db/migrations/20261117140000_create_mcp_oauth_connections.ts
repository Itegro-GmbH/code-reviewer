// SPDX-License-Identifier: LicenseRef-Proprietary

// The OAuth connection of an MCP server (#1051, epic #1049; the kind `oauth` that `mcp_servers.auth_kind` reserved). One row belongs to one
// server (`server_id` is the key and a foreign key that cascades: removing the server removes its connection, tokens and registration with it).
// It holds, in three groups:
//
// - what discovery found (`discovery`, JSON, nothing secret): the resource, the authorization server's issuer and endpoints (RFC 9728, RFC 8414),
//   the scopes to ask for. Kept so the callback uses the endpoints the person was sent to, never a second discovery;
// - the OAuth client: either entered by an Owner or Admin (`client_source = 'manual'`, the fallback when the authorization server has no dynamic
//   registration) or registered by this server (`'dynamic'`, RFC 7591; `registered_issuer` and `registered_redirect_uri` say what it was
//   registered for, so another issuer or callback registers again). A client secret, when there is one, is sealed in the three `client_secret_*`
//   columns;
// - the token pair, ONE sealed JSON text (AES-256-GCM, `src/crypto/secret-box.ts`; the table, the row id = the server id and the field `tokens`
//   are bound into the ciphertext), replaced in one statement. `token_version` counts the writes of the pair: a refresh only replaces the
//   version it read (compare and swap), so two refreshes cannot overwrite each other. `access_expires_at` is not secret and lets the code decide
//   whether a refresh is due without opening the seal.
//
// `status` is `unconnected` (a row for the client or the discovery only: no tokens yet), `connected` or `broken` (the authorization server
// refused the refresh token: mended by connecting again; the old pair stays in the row until then). The constraints make the groups agree.
// A row exists only for a server with the kind `oauth`; the registry deletes it when the address, the transport or the kind changes (the
// tokens were issued for another resource).
//
// Expand only, safe for the version that is still running (it never reads the table) and for the live database: one new table, no column,
// row or index of an existing table changes. The foreign keys take a short lock on `mcp_servers` and `workspaces`; the wait is bounded: after
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
      .createTable("mcp_oauth_connections")
      .addColumn("server_id", "text", (column) =>
        column.primaryKey().references("mcp_servers.id").onDelete("cascade"),
      )
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("status", "text", (column) =>
        column.notNull().defaultTo("unconnected"),
      )
      .addColumn("error_code", "text")
      .addColumn("discovery", "text")
      .addColumn("client_source", "text")
      .addColumn("client_id", "text")
      .addColumn("client_auth_method", "text")
      .addColumn("client_secret_ciphertext", "text")
      .addColumn("client_secret_nonce", "text")
      .addColumn("client_secret_key_version", "integer")
      .addColumn("registered_issuer", "text")
      .addColumn("registered_redirect_uri", "text")
      .addColumn("tokens_ciphertext", "text")
      .addColumn("tokens_nonce", "text")
      .addColumn("tokens_key_version", "integer")
      .addColumn("token_version", "integer", (column) =>
        column.notNull().defaultTo(1),
      )
      .addColumn("access_expires_at", "text")
      // The scopes the authorization server granted, separated by a space; null before a grant.
      .addColumn("scopes", "text")
      .addColumn("connected_by", "text", (column) =>
        column.references("users.id").onDelete("set null"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "mcp_oauth_connections_status_check",
        sql`status in ('unconnected', 'connected', 'broken')`,
      )
      .addCheckConstraint(
        "mcp_oauth_connections_error_check",
        sql`(status = 'broken') = (error_code is not null)`,
      )
      .addCheckConstraint(
        "mcp_oauth_connections_tokens_check",
        sql`(status = 'unconnected') = (tokens_ciphertext is null)
          and (tokens_ciphertext is null) = (tokens_nonce is null)
          and (tokens_ciphertext is null) = (tokens_key_version is null)
          and (tokens_ciphertext is null) = (access_expires_at is null)`,
      )
      .addCheckConstraint(
        "mcp_oauth_connections_client_check",
        sql`(client_source is null or client_source in ('manual', 'dynamic'))
          and (client_source is null) = (client_id is null)
          and (client_source is null) = (client_auth_method is null)
          and (client_secret_ciphertext is null) = (client_secret_nonce is null)
          and (client_secret_ciphertext is null) = (client_secret_key_version is null)
          and (client_id is not null or client_secret_ciphertext is null)`,
      )
      .execute();

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("mcp_oauth_connections").execute();
  },
};
