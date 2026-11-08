// SPDX-License-Identifier: LicenseRef-Proprietary

// A run is active or discarded (#921). A member can discard any run (running, waiting or finished); a discarded run is over, frees its
// ticket, and stays listed. What changes:
//  - `workflow_runs.status` takes `discarded`. `cancelled` stays in the check: rows of the cancel of #891 are legacy and keep reading;
//  - `workflow_runs.discarded_at`: when the run was discarded; null for every run that exists. A discarded run has a `finished_at` like any
//    run that is over, so the end check keeps its first half. Its second half takes `discarded` next to `failed` for an `error_code`: a
//    failed run that is discarded keeps the code that says why it failed;
//  - `workflow_runs.pause_requested_at`: when a member asked the run to stop after its current step; null for every run that exists and
//    for a run that was resumed. The engine starts no new step of a run that has it.
// The one-run-per-ticket indexes count `running` and `waiting` runs only, so a discarded run frees its ticket with no change to them.
//
// Expand only, safe for the live database and for the version that is still running:
//  - the old version never reads the columns and never writes `discarded`; a discarded run is not `running`, so its sweep leaves it alone,
//    and a page of the old version shows the status text as it is;
//  - `add column` without a default changes the catalog only. It takes a short exclusive lock; the wait is bounded: after `LOCK_TIMEOUT` the
//    migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the two checks are dropped and added again as plain `add constraint`s: each scans the table once, a row per run, milliseconds.
//
// `down` puts the old rules back, which Postgres refuses while a `discarded` run exists: take those runs away first.
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

    await sql`alter table workflow_runs add column if not exists discarded_at text`.execute(
      db,
    );
    await sql`alter table workflow_runs add column if not exists pause_requested_at text`.execute(
      db,
    );
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_status_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_status_check
      check (status in ('running', 'waiting', 'succeeded', 'failed', 'cancelled', 'discarded'))`.execute(
      db,
    );
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_end_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_end_check
      check ((status in ('running', 'waiting')) = (finished_at is null)
        and (status in ('failed', 'discarded') or error_code is null))`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_end_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_end_check
      check ((status in ('running', 'waiting')) = (finished_at is null)
        and (status = 'failed' or error_code is null))`.execute(db);
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_status_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_status_check
      check (status in ('running', 'waiting', 'succeeded', 'failed', 'cancelled'))`.execute(
      db,
    );
    await sql`alter table workflow_runs drop column if exists pause_requested_at`.execute(
      db,
    );
    await sql`alter table workflow_runs drop column if exists discarded_at`.execute(
      db,
    );
  },
};
