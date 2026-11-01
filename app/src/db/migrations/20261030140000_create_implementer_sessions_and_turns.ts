// SPDX-License-Identifier: LicenseRef-Proprietary

// The data model of the Implementer (#751, part of #745): `implementer_sessions` (a branch the agent works on, its last pushed
// commit, the saved OpenCode session and a summary) and `implementer_turns` (one instruction each; this slice makes one per
// session). A turn is a row of `jobs` too: the status of a turn is the status of its job (`job_id`, unique), so there is no
// second state machine. `slot` numbers the sessions of a repository (1, 2, ...); the queue (#752) gives the job of a turn the
// negative `-slot` as its pull request number, so "one running job per pull request" becomes "one running turn per session".
// Timestamps are ISO 8601 text in UTC; `model_choice` is JSON text of `{entryId}` or `{provider, model}`.
//
// The database itself keeps the workspaces apart, as `repositories` and `jobs` do (src/db/README.md, "Workspaces"): a session
// names its repository with a composite key `(repository_id, workspace_id)`, a turn its session and its job the same way. The
// target of the second needs a unique index `(id, workspace_id)` on `jobs`, which is the one change to an existing table.
//
// Expand only, safe for the version that is still running (it never reads these tables) and for the live database:
//  - no column, row or existing index changes; two tables and one unique index are added;
//  - the index is a plain `create unique index` (the migrator's transaction cannot take `CONCURRENTLY`), which blocks writes to
//    `jobs` while it builds and while it waits for a writer that has not ended. The build is short (the table is small, the key
//    is its primary key plus one column), and the wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch
//    is rolled back (`MIGRATION_FAILED`, nothing half applied) and the deployment can simply be run again. A queue that waited
//    behind a long lock request would be worse than a failed deployment. The same bound covers the foreign keys, which take a
//    short lock on `jobs`, `repositories`, `workspaces` and `users`.
//  - the order matters. A lock taken in a migration is held until the batch commits, and every `create table` with a foreign
//    key waits for a writer on the tables it names (up to LOCK_TIMEOUT each). The statements that touch `jobs` therefore come
//    LAST: both tables are created first (the turns without their link to `jobs`), then the index, then the link. While the
//    migration waits for `workspaces`, `users` or `repositories` it holds nothing on `jobs`, so jobs writes (the queue) go on.
//    The reverse holds: the locks the foreign keys took on `users`, `repositories` and `workspaces` are held until the batch
//    commits, so writes to those three wait for as long as the rest of the migration runs, the index's wait for a writer on
//    `jobs` included. LOCK_TIMEOUT is per statement (each waiting statement gives up after it), so waits add up.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** How long the migration waits for a lock before it gives up. Exported for the test that holds a writer open. */
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
      .createTable("implementer_sessions")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("repository_id", "text", (column) => column.notNull())
      .addColumn("slot", "integer", (column) => column.notNull())
      .addColumn("base_branch", "text", (column) => column.notNull())
      .addColumn("branch", "text", (column) => column.notNull())
      .addColumn("head_commit", "text")
      .addColumn("status", "text", (column) =>
        column.notNull().defaultTo("running"),
      )
      .addColumn("opencode_session_id", "text")
      .addColumn("opencode_version", "text")
      .addColumn("summary", "text")
      .addColumn("created_by", "text", (column) =>
        column.notNull().references("users.id"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addForeignKeyConstraint(
        "implementer_sessions_repository_fk",
        ["repository_id", "workspace_id"],
        "repositories",
        ["id", "workspace_id"],
      )
      .addUniqueConstraint("implementer_sessions_id_workspace_unique", [
        "id",
        "workspace_id",
      ])
      .addUniqueConstraint("implementer_sessions_repository_slot_unique", [
        "repository_id",
        "slot",
      ])
      .addUniqueConstraint("implementer_sessions_repository_branch_unique", [
        "repository_id",
        "branch",
      ])
      .addCheckConstraint(
        "implementer_sessions_status_check",
        sql`status in ('running', 'idle')`,
      )
      .addCheckConstraint("implementer_sessions_slot_check", sql`slot >= 1`)
      .execute();

    await db.schema
      .createTable("implementer_turns")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("session_id", "text", (column) => column.notNull())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("number", "integer", (column) => column.notNull())
      .addColumn("instruction", "text", (column) => column.notNull())
      .addColumn("model_choice", "text", (column) => column.notNull())
      .addColumn("cost_limit_cents", "integer")
      .addColumn("job_id", "text", (column) => column.notNull())
      .addColumn("created_by", "text", (column) =>
        column.notNull().references("users.id"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addForeignKeyConstraint(
        "implementer_turns_session_fk",
        ["session_id", "workspace_id"],
        "implementer_sessions",
        ["id", "workspace_id"],
      )
      .addUniqueConstraint("implementer_turns_job_unique", ["job_id"])
      .addUniqueConstraint("implementer_turns_session_number_unique", [
        "session_id",
        "number",
      ])
      .addCheckConstraint("implementer_turns_number_check", sql`number >= 1`)
      .addCheckConstraint(
        "implementer_turns_cost_limit_check",
        sql`cost_limit_cents is null or cost_limit_cents > 0`,
      )
      .execute();

    // The target of the composite key of a turn's job. `id` is the primary key already, so this can never fail on data.
    await db.schema
      .createIndex("jobs_id_workspace_unique")
      .on("jobs")
      .columns(["id", "workspace_id"])
      .unique()
      .execute();

    // The turn's link to its job, last because it needs the lock on `jobs` (already held by the index). The table is empty.
    await db.schema
      .alterTable("implementer_turns")
      .addForeignKeyConstraint(
        "implementer_turns_job_fk",
        ["job_id", "workspace_id"],
        "jobs",
        ["id", "workspace_id"],
      )
      .execute();

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("implementer_turns").execute();
    await db.schema.dropTable("implementer_sessions").execute();
    await db.schema.dropIndex("jobs_id_workspace_unique").execute();
  },
};
