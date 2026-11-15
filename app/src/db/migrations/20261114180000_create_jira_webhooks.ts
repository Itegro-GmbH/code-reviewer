// SPDX-License-Identifier: LicenseRef-Proprietary

// The dynamic webhooks the factory registers at a Jira Cloud site for a project's ticket source (#1039, epic #1034). One row per project:
// which connection and Jira project the webhook watches (`project = KEY`), Jira's id of it once registered, when it expires (Atlassian ends
// a webhook registered through the REST API after 30 days; the nightly job extends it), and the hash of the secret in the address Jira
// calls. The secret itself is never stored: it is made when the webhook is registered, sent to Atlassian inside the address, and only its
// SHA-256 is kept to compare against (`src/jira/webhook-verify.ts`).
//
// `status`: `pending` (the row exists, the webhook is not registered at Jira yet or its registration failed: `error_code` says why),
// `active` (registered; `jira_webhook_id` and `expires_at` are set) and `removing` (the project's source is gone; the webhook at Jira is
// deleted by the next reconcile, then the row goes). One row per project (unique `project_id`); the connection is a foreign key that
// cascades, as a removed connection has no access left to delete anything with.
//
// Expand only, safe for the version that is still running (it never reads the table) and for the live database: one new table, nothing
// of an existing table changes. The foreign keys take a short lock on `workspaces` and `jira_connections`; the wait is bounded by
// `LOCK_TIMEOUT` (after it the migration gives up, the batch rolls back, the deployment can be run again). `down` drops the table.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** How long the migration waits for a lock before it gives up. */
export const LOCK_TIMEOUT = "5s";

export const migration: Migration = {
  async up(db) {
    const { rows } = await sql<{
      value: string;
    }>`select current_setting('lock_timeout') as value`.execute(db);
    const before = rows[0]?.value ?? "0";
    await sql`set local lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(db);

    await db.schema
      .createTable("jira_webhooks")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      // The project whose ticket source this webhook serves. No foreign key: the row of a project that is gone is removed by the reconcile.
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("connection_id", "text", (column) =>
        column.notNull().references("jira_connections.id").onDelete("cascade"),
      )
      .addColumn("project_key", "text", (column) => column.notNull())
      // SHA-256 (hex) of the secret in the address the webhook calls.
      .addColumn("secret_hash", "text", (column) => column.notNull())
      // SHA-256 (hex) of the secret of a registration that is under way (a first one, a new one after Jira lost the webhook, or a rotation):
      // a delivery with it is accepted too, until `mark registered` makes it the secret and clears this; null otherwise.
      .addColumn("pending_secret_hash", "text")
      // When the webhook was registered (what the nightly job rotates the secret by); null until it is registered.
      .addColumn("registered_at", "text")
      // When a delivery of this registration first carried a bearer token that verified: from then on a delivery without one is refused
      // (trust on first use, `src/jira/webhook-verify.ts`); null while none has.
      .addColumn("bearer_seen_at", "text")
      .addColumn("status", "text", (column) => column.notNull())
      // Jira's id of the registered webhook (a number, kept as text); null until it is registered.
      .addColumn("jira_webhook_id", "text")
      // When Jira ends the webhook unless it is extended; null until it is registered.
      .addColumn("expires_at", "text")
      // Why the last registration or extension failed (a code of `src/jira/errors.ts`); null after a success.
      .addColumn("error_code", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "jira_webhooks_status_check",
        sql`status in ('pending', 'active', 'removing')`,
      )
      .addCheckConstraint(
        "jira_webhooks_active_check",
        sql`status <> 'active' or (jira_webhook_id is not null and expires_at is not null)`,
      )
      .execute();
    await sql`create unique index jira_webhooks_project_unique
      on jira_webhooks (project_id)`.execute(db);
    await sql`create index jira_webhooks_connection_index
      on jira_webhooks (connection_id)`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("jira_webhooks").execute();
  },
};
