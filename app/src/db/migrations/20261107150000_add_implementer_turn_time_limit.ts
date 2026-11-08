// SPDX-License-Identifier: LicenseRef-Proprietary

// The time limit of a turn (#918): `implementer_turns` gets `time_limit_minutes`, the minutes the turn may run, copied from the
// `turnTimeLimitMinutes` of the workflow that started it. Null for every turn that exists and for every turn that no workflow started,
// which keep the platform's 60 minutes.
//
// Expand only, safe for the version that is still running (it never reads or writes the column) and for the live database:
//  - one nullable column without a default is added, which Postgres does without rewriting the table; every existing row reads null;
//  - `add column` takes a short exclusive lock on `implementer_turns`, a table of one row per task. The wait is bounded: after
//    `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the check is added `not valid` and validated afterwards, so it does not scan the table under the exclusive lock; every row that
//    exists is null, which passes.
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

    await sql`alter table implementer_turns add column if not exists time_limit_minutes integer`.execute(
      db,
    );
    await sql`alter table implementer_turns drop constraint if exists implementer_turns_time_limit_check`.execute(
      db,
    );
    await sql`alter table implementer_turns add constraint implementer_turns_time_limit_check
      check (time_limit_minutes is null or time_limit_minutes between 15 and 60) not valid`.execute(
      db,
    );
    await sql`alter table implementer_turns validate constraint implementer_turns_time_limit_check`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table implementer_turns drop constraint if exists implementer_turns_time_limit_check`.execute(
      db,
    );
    await sql`alter table implementer_turns drop column if exists time_limit_minutes`.execute(
      db,
    );
  },
};
