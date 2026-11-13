// SPDX-License-Identifier: LicenseRef-Proprietary

// The labels a job requires (#971, Runner v2): `jobs.required_labels`, one label on each line like `implementer_turns.environment_labels`.
// A dispatcher takes a job only when it has all of them. A hosted job gets `cr:managed` and its size label when it is enqueued, a turn of a
// runner environment the labels of the environment.
//
// Expand only, safe for the version that is still running (it never reads or writes the column) and for the live database: one nullable
// column without a default, which Postgres adds without rewriting the table, and no check (a check would scan `jobs`, the biggest table,
// under the lock). Null is a job written before the labels, or by an instance of the previous release during the deployment. Existing
// rows are NOT rewritten: the claim reads a null as "derive it" (a turn of a runner environment requires the labels of its environment,
// every other job `cr:managed`), so a queued job is routed exactly as before and nothing waits for a backfill.
//
// The wait for the lock is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and
// the deployment can simply be run again. `down` drops the column.
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

    await sql`alter table jobs add column required_labels text`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table jobs drop column required_labels`.execute(db);
  },
};
