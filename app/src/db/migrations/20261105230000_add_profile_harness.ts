// SPDX-License-Identifier: LicenseRef-Proprietary

// The harness of a profile (#856, plan decision 4): `profile_versions` gets `harness`, and `implementer_turns` gets `profile_harness`,
// the copy the turn takes when it starts (the claim reads the harness from the turn alone, as it does the model and the push right).
// Null reads as OpenCode, the platform's one harness: every version and every turn written before this migration, and every one a
// release that does not know the column writes, keep running as they did. `claude-code` is the second harness of a profile; it runs
// only on a runner that announces it as ready.
//
// Expand only, safe for the version that is still running (it never reads or writes these columns) and for the live database:
//  - two nullable columns without a default are added, which Postgres does without rewriting a table; no existing row, index or
//    constraint changes;
//  - `add column` takes a short exclusive lock on each table. The wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the
//    whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the checks are plain `add constraint`s: each scans its table once under the lock the `add column` already holds (a row per
//    saved version, a row per task: milliseconds).
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

    await sql`alter table profile_versions add column harness text`.execute(db);
    await sql`alter table profile_versions add constraint profile_versions_harness_check check (
        harness is null or harness in ('opencode', 'claude-code')
      )`.execute(db);
    await sql`alter table implementer_turns add column profile_harness text`.execute(
      db,
    );
    // A harness belongs to a profile: a task without one has none.
    await sql`alter table implementer_turns add constraint implementer_turns_profile_harness_check check (
        profile_harness is null
        or (profile_id is not null and profile_harness in ('opencode', 'claude-code'))
      )`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table implementer_turns drop constraint implementer_turns_profile_harness_check`.execute(
      db,
    );
    await sql`alter table implementer_turns drop column profile_harness`.execute(
      db,
    );
    await sql`alter table profile_versions drop constraint profile_versions_harness_check`.execute(
      db,
    );
    await sql`alter table profile_versions drop column harness`.execute(db);
  },
};
