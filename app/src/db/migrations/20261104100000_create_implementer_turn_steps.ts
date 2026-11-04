// SPDX-License-Identifier: LicenseRef-Proprietary

// The steps of a turn of the Implementer (#745, live view): what the agent thinks and does, one row for each part of the engine's
// messages (`reasoning`, `text`, `tool`, `step`), keyed by the job and the part id. The runner sends a part again when it changes
// (a tool: running, then done) with a higher `seq`; the row keeps the highest `seq` it has seen (the app's upsert), so a retry or
// a batch that arrives out of order changes nothing. `ordinal` is the `seq` of the first record of the part: the order in which
// the page shows the parts, which `seq` alone cannot give (a part that changed has a later `seq` than the ones after it).
// `payload` is the record without `kind`, `partId` and `seq` as JSON text (like `model_choice`: the schema is text and integers
// only, the same on both engines, `src/db/migrate.integration.test.ts`); `bytes` is its size, so the cap of a turn is a sum and not a scan
// of documents. No tool output is ever stored here (decision 9 of the plan): a tool record carries name, status, title, input and error.
//
// The database keeps the workspaces apart, as the other Implementer tables do: the row names its job with a composite key
// `(job_id, workspace_id)` to `jobs` (the unique index `jobs_id_workspace_unique` of #751 is its target).
//
// Expand only, safe for the version that is still running (it never reads the table) and for the live database:
//  - one table and one index are added; no column, row or index of an existing table changes;
//  - the table is created without its link to `jobs`, and the link is added last, so the migration waits for a writer on `workspaces`
//    first (holding nothing on `jobs`, so the queue goes on) and takes the short lock on `jobs` at the end. The foreign keys take a
//    short lock on `jobs` and `workspaces`. The wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is
//    rolled back (`MIGRATION_FAILED`, nothing half applied) and the deployment can simply be run again;
//  - the table is empty, so the index and the foreign key scan nothing.
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
      .createTable("implementer_turn_steps")
      .addColumn("job_id", "text", (column) => column.notNull())
      .addColumn("part_id", "text", (column) => column.notNull())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("seq", "integer", (column) => column.notNull())
      .addColumn("ordinal", "integer", (column) => column.notNull())
      .addColumn("kind", "text", (column) => column.notNull())
      .addColumn("payload", "text", (column) => column.notNull())
      .addColumn("bytes", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("implementer_turn_steps_pkey", [
        "job_id",
        "part_id",
      ])
      .addCheckConstraint("implementer_turn_steps_seq_check", sql`seq >= 1`)
      .addCheckConstraint(
        "implementer_turn_steps_ordinal_check",
        sql`ordinal >= 1`,
      )
      .addCheckConstraint(
        "implementer_turn_steps_kind_check",
        sql`kind ~ '^[a-z][a-z-]{0,31}$'`,
      )
      .addCheckConstraint(
        "implementer_turn_steps_part_id_check",
        sql`char_length(part_id) between 1 and 256`,
      )
      .addCheckConstraint("implementer_turn_steps_bytes_check", sql`bytes >= 0`)
      .execute();

    // Reading the steps after a `seq` (the page asks for what changed since its last answer).
    await db.schema
      .createIndex("implementer_turn_steps_job_seq_index")
      .on("implementer_turn_steps")
      .columns(["job_id", "seq"])
      .execute();

    // The row's link to its job, last because it needs the lock on `jobs`. The table is empty.
    await db.schema
      .alterTable("implementer_turn_steps")
      .addForeignKeyConstraint(
        "implementer_turn_steps_job_fk",
        ["job_id", "workspace_id"],
        "jobs",
        ["id", "workspace_id"],
      )
      .execute();

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("implementer_turn_steps").execute();
  },
};
