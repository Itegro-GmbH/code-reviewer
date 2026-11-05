// SPDX-License-Identifier: LicenseRef-Proprietary

// The next instruction of an Implementer session (#841, follow-up turns): while a turn runs, a person may queue exactly one more
// instruction, which starts when the turn ends. `implementer_sessions` gets two nullable text columns:
//  - `queued_instruction`: JSON text of the queued instruction with the choices already checked and copied (model, cost limit,
//    environment, profile, result schema), the client request id, who queued it and when; null when nothing is queued. The writer
//    holds it to the bound of the check below.
//  - `queued_discarded`: JSON text of a queued instruction that could not start (`reason`, the instruction, when), kept so the Runs
//    page can say so; null otherwise. Queueing again or starting a turn clears it.
//
// Expand only, safe for the version that is still running (it never reads or writes these columns) and for the live database:
//  - two nullable columns without a default are added, which Postgres does without rewriting a table; no existing row, index or
//    constraint changes, and every existing session reads null (nothing queued);
//  - `add column` takes a short exclusive lock on `implementer_sessions`, a table of one row per task. The wait is bounded: after
//    `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the check is a plain `add constraint`: it scans the table once under the lock the `add column` already holds (a row per task).
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

    await sql`alter table implementer_sessions add column queued_instruction text`.execute(
      db,
    );
    await sql`alter table implementer_sessions add column queued_discarded text`.execute(
      db,
    );
    // An instruction is at most 20,000 characters and the copies (a setup script, a profile) are bounded too: 512 KiB is far above
    // any real row and keeps a stray value out.
    await sql`alter table implementer_sessions add constraint implementer_sessions_queue_check check (
        (queued_instruction is null or char_length(queued_instruction) <= 524288)
        and (queued_discarded is null or char_length(queued_discarded) <= 524288)
      )`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table implementer_sessions drop constraint implementer_sessions_queue_check`.execute(
      db,
    );
    await sql`alter table implementer_sessions drop column queued_discarded`.execute(
      db,
    );
    await sql`alter table implementer_sessions drop column queued_instruction`.execute(
      db,
    );
  },
};
