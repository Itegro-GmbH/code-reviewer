// SPDX-License-Identifier: LicenseRef-Proprietary

// The result schema of a task and the result the agent handed in (#843): `implementer_turns` gets a copy of the schema the task ran
// with (its own, or the default of its profile version) and, when the turn ended with a result that fits, the result itself. A task
// without a schema has both columns null and runs exactly as every task did before result schemas.
//
// Expand only, safe for the version that is still running (it never reads or writes these columns) and for the live database:
//  - two nullable columns without a default are added, which Postgres does without rewriting a table; no existing row, index or
//    constraint changes, and every existing row reads null (no schema, no result);
//  - `add column` takes a short exclusive lock on `implementer_turns`, a table of one row per task. The wait is bounded: after
//    `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the checks are plain `add constraint`s: they scan the table once under the lock the `add column` already holds. A row per task,
//    a few thousand at most, so the scan is milliseconds.
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

    await sql`alter table implementer_turns add column result_schema text`.execute(
      db,
    );
    await sql`alter table implementer_turns add column result_value text`.execute(
      db,
    );
    // The schema is JSON text the validator of the format accepted (at most 128 KB, the bound of a body); the result is JSON text
    // of at most 256 KiB, and only a turn that has a schema has one.
    await sql`alter table implementer_turns add constraint implementer_turns_result_check check (
        (result_schema is null or char_length(result_schema) <= 131072)
        and (result_value is null or (result_schema is not null and char_length(result_value) <= 262144))
      )`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table implementer_turns drop constraint implementer_turns_result_check`.execute(
      db,
    );
    await sql`alter table implementer_turns drop column result_value`.execute(
      db,
    );
    await sql`alter table implementer_turns drop column result_schema`.execute(
      db,
    );
  },
};
