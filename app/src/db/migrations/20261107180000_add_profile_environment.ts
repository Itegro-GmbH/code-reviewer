// SPDX-License-Identifier: LicenseRef-Proprietary

// The environment of a profile (#919): `profile_versions` gets `environment_id`, the environment of the workspace the profile runs in
// (a hosted VM or a runner). A profile says who works and where, so a step of a workflow no longer has to name an environment. Null for
// every version that exists: those were saved when the environment was a literal of the step, and they keep running with the
// environment their step names.
//
// Expand only, safe for the version that is still running (it never reads or writes the column) and for the live database:
//  - one nullable column without a default is added, which Postgres does without rewriting the table; every existing row reads null;
//  - no foreign key: a version is history and is never changed, and an environment can be removed while a version still names it (the
//    check of a workflow and the start of a step then say the environment is gone);
//  - `add column` takes a short exclusive lock on `profile_versions`, a table of one row per saved version. The wait is bounded: after
//    `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again.
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

    await sql`alter table profile_versions add column if not exists environment_id text`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table profile_versions drop column if exists environment_id`.execute(
      db,
    );
  },
};
