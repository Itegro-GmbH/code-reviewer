// SPDX-License-Identifier: LicenseRef-Proprietary

// The profile a task ran with (#843): `implementer_turns` gets a copy of the profile version the person chose, so that the claim reads
// the model, the instructions, the cost limit and the push right from the turn alone, whatever is done to the profile afterwards.
// The model choice and the cost limit are the turn's existing columns (`model_choice`, `cost_limit_cents`): a turn started with a profile
// has the version's values there. A task without a profile has all five new columns null and runs with the platform's own defaults,
// exactly as every task did before profiles.
//
// Expand only, safe for the version that is still running (it never reads or writes these columns) and for the live database:
//  - five nullable columns without a default are added, which Postgres does without rewriting a table; no existing row, index or
//    constraint changes, and every existing row reads null (no profile);
//  - `add column` takes a short exclusive lock on `implementer_turns`, a table of one row per task. The wait is bounded: after
//    `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the check is a plain `add constraint`: it scans the table once under the lock the `add column` already holds. A row per task, a
//    few thousand at most, so the scan is milliseconds.
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

    for (const column of [
      "profile_id text",
      "profile_name text",
      "profile_version integer",
      "profile_instructions text",
      "profile_can_push boolean",
    ])
      await sql
        .raw(`alter table implementer_turns add column ${column}`)
        .execute(db);
    // All or none: a turn has a profile (which version, what it says) or it has not.
    await sql`alter table implementer_turns add constraint implementer_turns_profile_check check (
        (profile_id is null and profile_name is null and profile_version is null and profile_instructions is null and profile_can_push is null)
        or (profile_id is not null and profile_name is not null and profile_version is not null and profile_version >= 1
            and profile_instructions is not null and char_length(profile_instructions) <= 20000 and profile_can_push is not null)
      )`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table implementer_turns drop constraint implementer_turns_profile_check`.execute(
      db,
    );
    for (const column of [
      "profile_can_push",
      "profile_instructions",
      "profile_version",
      "profile_name",
      "profile_id",
    ])
      await sql
        .raw(`alter table implementer_turns drop column ${column}`)
        .execute(db);
  },
};
