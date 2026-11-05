// SPDX-License-Identifier: LicenseRef-Proprietary

// The runners of a customer's own machine (#854, R1a of the runner epic #852): a registration token a member of a workspace makes, and
// the runner that exchanges it for a credential of its own. Both are workspace data. The database keeps only hashes: the token and the
// credential are shown once, where they are made, and a hash of 256 random bits cannot be turned back into them.
//
// `runner_registration_tokens`: short lived (`expires_at`), usable once (`used_at`, set by one conditional update, so two runners
// racing for the same token cannot both win), unique by hash. `runner_id` names the runner it made.
//
// `runners`: the labels (one on each line, lower case), the version of the base, the manifest (the harnesses it announces with their
// version and readiness, and the capabilities such as `agent-docker`) and the limits, as the runner reported them; `last_seen_at`
// (every call of the runner), `revoked_at` (a revoked runner is refused at once). A renewed credential keeps the previous hash until
// the runner uses the new one, so an answer lost on the way does not lock a runner out.
//
// Expand only, safe for the version that is still running (it never reads the tables) and for the live database:
//  - two tables are added; no column, row or index of an existing table changes;
//  - the tables have foreign keys to `workspaces` and (`runner_registration_tokens`) `users`, which take a short lock on those
//    tables. The wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`)
//    and the deployment can simply be run again.
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
      .createTable("runners")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("name", "text", (column) => column.notNull())
      // One label on each line, lower case, sorted: the order of the line is not the runner's.
      .addColumn("labels", "text", (column) => column.notNull())
      .addColumn("base_version", "text", (column) => column.notNull())
      // JSON text, as the runner announced it and the app checked it.
      .addColumn("manifest", "text", (column) => column.notNull())
      .addColumn("limits", "text", (column) => column.notNull())
      // sha256 (hex) of the credential, and of the one a renewal replaced until the new one is used.
      .addColumn("credential_hash", "text", (column) =>
        column.notNull().unique(),
      )
      .addColumn("previous_credential_hash", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("last_seen_at", "text", (column) => column.notNull())
      // Set when a member revoked the runner: every call of it answers 401 from then on.
      .addColumn("revoked_at", "text")
      .addCheckConstraint(
        "runners_name_check",
        sql`char_length(name) between 1 and 80`,
      )
      .addCheckConstraint(
        "runners_labels_check",
        sql`octet_length(labels) <= 1000`,
      )
      .addCheckConstraint(
        "runners_base_version_check",
        sql`char_length(base_version) between 1 and 64`,
      )
      .addCheckConstraint(
        "runners_manifest_check",
        sql`octet_length(manifest) <= 16384`,
      )
      .addCheckConstraint(
        "runners_limits_check",
        sql`octet_length(limits) <= 4096`,
      )
      .execute();
    await sql`create index runners_workspace_idx on runners (workspace_id, created_at)`.execute(
      db,
    );
    await sql`create unique index runners_previous_credential_unique
      on runners (previous_credential_hash) where previous_credential_hash is not null`.execute(
      db,
    );

    await db.schema
      .createTable("runner_registration_tokens")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("token_hash", "text", (column) => column.notNull().unique())
      .addColumn("created_by", "text", (column) =>
        column.notNull().references("users.id"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      // Set once, by the exchange that used the token; the runner it made is `runner_id`.
      .addColumn("used_at", "text")
      .addColumn("runner_id", "text")
      .addCheckConstraint(
        "runner_registration_tokens_used_check",
        sql`(used_at is null) = (runner_id is null)`,
      )
      .execute();
    await sql`create index runner_registration_tokens_workspace_idx
      on runner_registration_tokens (workspace_id, created_at)`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("runner_registration_tokens").execute();
    await db.schema.dropTable("runners").execute();
  },
};
