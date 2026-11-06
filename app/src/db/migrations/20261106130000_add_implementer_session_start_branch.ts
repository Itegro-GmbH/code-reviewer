// SPDX-License-Identifier: LicenseRef-Proprietary

// The branch a session branch is made from, apart from its base (#909): a step of a workflow that starts from the branch of an earlier
// step has the run's base as `base_branch` and the branch of that step as `start_branch`. Null for every session that exists and for a
// session that starts at the tip of its base, as before. The first turn's job carries it to the runner; nothing reads it otherwise.
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

    await sql`alter table implementer_sessions add column start_branch text`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table implementer_sessions drop column start_branch`.execute(
      db,
    );
  },
};
