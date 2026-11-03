// SPDX-License-Identifier: LicenseRef-Proprietary

// The environments of the Implementer (#818, part of #745): a start configuration for a task, a size (vCPUs) and a setup script,
// kept per workspace. The table is new and empty; a task copies what it needs at its start (a later migration adds the snapshot
// columns to `implementer_turns`), so a row here is never referenced by another table: editing or deleting an environment
// touches no turn, running or past.
//
// Expand only, safe for the version that is still running (it never reads the table) and for the live database:
//  - one table is added; no column, row or index of an existing table changes, and nothing is taken from `jobs`;
//  - the table has two foreign keys (`workspaces`, `users`), which take a short lock on those tables. The wait is bounded: after
//    `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can simply be
//    run again. A writer that waited behind a long lock request would be worse than a failed deployment.
//  - `vcpus` is checked for `>= 1` only: the list of sizes belongs to the platform and changes with it
//    (`contracts/environment-sizes.v1.json`), a check on the list would need a migration for every new size. The app and the
//    Dispatcher hold the list.
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
      .createTable("implementer_environments")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("vcpus", "integer", (column) => column.notNull())
      .addColumn("setup_script", "text", (column) =>
        column.notNull().defaultTo(""),
      )
      .addColumn("created_by", "text", (column) =>
        column.notNull().references("users.id"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "implementer_environments_name_check",
        sql`char_length(name) between 1 and 80`,
      )
      .addCheckConstraint(
        "implementer_environments_vcpus_check",
        sql`vcpus >= 1`,
      )
      // 64 KB of UTF-8, the bound of the issue; the app checks the same and says which rule broke.
      .addCheckConstraint(
        "implementer_environments_setup_script_check",
        sql`octet_length(setup_script) <= 65536`,
      )
      .execute();

    // One name once per workspace, whatever its case.
    await sql`create unique index implementer_environments_workspace_name_unique
      on implementer_environments (workspace_id, lower(name))`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("implementer_environments").execute();
  },
};
