// SPDX-License-Identifier: LicenseRef-Proprietary

// The change description of a lane version (#1107, epic #1103, ADR 0007): what a version changed against the one before, written by
// whoever saved it (a person or an AI) and shown in the list of versions. Version 1 has none (the lane's own description serves), and
// neither does any version that was saved before this migration: they read null and the page shows a neutral note. The text is for
// people; nothing reads it but the page. Like the rest of a version it is immutable (the trigger of `workflow_versions` refuses an update).
//
// Expand only, safe for the version that is still running (it never reads or writes the column) and for the live database:
//  - one nullable column without a default is added, which Postgres does without rewriting the table;
//  - the wait for the lock is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back
//    (`MIGRATION_FAILED`) and the deployment can be run again.
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

    await sql`alter table workflow_versions add column change_description text`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table workflow_versions drop column change_description`.execute(
      db,
    );
  },
};
