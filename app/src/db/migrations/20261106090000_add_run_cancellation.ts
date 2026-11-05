// SPDX-License-Identifier: LicenseRef-Proprietary

// Cancelling a running lane run (#891). Two columns and one wider check:
//  - `jobs.cancel_requested_at`: when a member asked for the running turn of a job to stop. The heartbeat answers `cancelRequested` while it
//    is set, the runner ends the turn (it pushes what is committed first) and reports `cancelled`; a lease that runs out or a claim that is
//    given back with it set ends the job `cancelled` instead of queueing it again. Null for every job that exists;
//  - `workflow_runs.cancel_requested_at`: when a member asked for the run to stop. The run stays `running` until its turn has ended, then
//    the engine ends it `cancelled` (its steps that did not start are written as skipped). Null for every run that exists;
//  - `workflow_runs_status_check` takes `cancelled` as a fourth status. The end check is unchanged: a run that ends has `finished_at`, and
//    only a failed run has an `error_code`.
//
// Expand only, safe for the live database and for the version that is still running:
//  - the old version never reads the columns and never writes `cancelled` to a run; the old engine's sweep treats a `cancelled` run like
//    any run that is not `running`, which it leaves alone;
//  - `add column` without a default changes the catalog only; Postgres does not rewrite the table. It takes a short exclusive lock on `jobs`
//    and `workflow_runs`; the wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back
//    (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the old status check is dropped and the wider one added under the same name in the same transaction, so there is no moment without a
//    check. `add constraint` reads the rows of `workflow_runs` once (one row per run, milliseconds) under the lock the statements before
//    already hold.
//
// `down` puts the old check back, which Postgres refuses while a `cancelled` run exists: take those runs away first.
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

    await sql`alter table workflow_runs add column if not exists cancel_requested_at text`.execute(
      db,
    );
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_status_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_status_check
      check (status in ('running', 'succeeded', 'failed', 'cancelled'))`.execute(
      db,
    );
    await sql`alter table jobs add column if not exists cancel_requested_at text`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_status_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_status_check
      check (status in ('running', 'succeeded', 'failed'))`.execute(db);
    await sql`alter table workflow_runs drop column if exists cancel_requested_at`.execute(
      db,
    );
    await sql`alter table jobs drop column if exists cancel_requested_at`.execute(
      db,
    );
  },
};
