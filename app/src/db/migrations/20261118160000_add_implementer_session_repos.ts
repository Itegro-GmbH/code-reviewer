// SPDX-License-Identifier: LicenseRef-Proprietary

// The repositories of a session of several repositories (#1092, epic #1090, ADR 0006): a step of a lane with `repos` starts a session
// that works on up to ten repositories. The list, as the first turn resolved it (the repository, its mount `name`, the `base` and the
// `branch`, never resolved again), is kept here as JSON text (`SessionRepo[]` in src/db/session-repos.ts). Null for every
// session that exists and for every session of a step without `repos`, which works on its one repository (`repository_id`, `base_branch`,
// `branch`) as always. A session with a list has the first repository of the list in `repository_id`, and a name of the platform's own
// in `branch` that keeps the unique index of the branch (`workflow/<run>/<step>`; no git branch of that name exists).
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

    await sql`alter table implementer_sessions add column repos text`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table implementer_sessions drop column repos`.execute(db);
  },
};
