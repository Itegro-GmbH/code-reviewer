// SPDX-License-Identifier: LicenseRef-Proprietary

// Rounds, branches and skipped steps in a workflow run (#846, agent workflows, milestone 5). Until now a run wrote every step of its
// document once. A `loop` runs its body several times and an `if` leaves a branch out, so `workflow_step_runs` changes in four ways:
//  - `round`: how often the step has run in the run, counted from 1 (the n-th run of the step). A step in a loop body gets 1, 2, 3 in
//    the rounds of its loop; in a loop inside a loop the count goes on across the rounds of the outer loop, so it stays unique. The
//    unique index on (`run_id`, `step_id`) becomes one on (`run_id`, `step_id`, `round`);
//  - `kind` may also be `if` and `loop`: the row of a control step holds what it decided (`{"taken": "then"}`, `{"exit": "until",
//    "rounds": 2}`) as its output, so that `{{done.taken}}` and `{{fix.exit}}` are values of the run like any other;
//  - `status` may also be `skipped`: a step in the branch an `if` did not take is written as a row, so the run page shows it;
//  - a skipped step is over like a succeeded one: it has a `finished_at` (the check `workflow_step_runs_end_check`).
//
// Expand only for the rows, safe for the live database; one case needs care in the deploy window:
//  - the version that is still running writes `round` 1 (the default) for every step and never reads the column, so its rows fit the
//    new index exactly as they fit the old one. It refuses to start a workflow with an `if` or a `loop`, so it never writes the new
//    kinds or the new status. But its sweep advances EVERY running run, including one the new version wrote shortly before the old one
//    stopped, and the old engine reads the document as a flat list: it can start the wrong step of a run with a loop. Such a run is
//    lost and harms nothing beyond its own budget; start the workflow again once the new version is up;
//  - `add column ... default 1` changes the catalog only (a constant default is stored once, not in the rows);
//  - the new index is created before the old one is dropped, so the table is never without a uniqueness rule;
//  - the checks are dropped and added again as plain `add constraint`: each scans the table once under the lock the statements before
//    already hold, a row per step of a run, milliseconds. The wait for the lock is bounded: after `LOCK_TIMEOUT` the migration gives up,
//    the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again.
//
// `down` puts the old rules back, which Postgres refuses while a step of a loop (the same step id twice), a control step or a skipped
// step exists: take those runs away first.
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

    await sql`alter table workflow_step_runs add column round integer not null default 1`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add constraint workflow_step_runs_round_check check (round >= 1)`.execute(
      db,
    );
    await sql`create unique index workflow_step_runs_round_unique
      on workflow_step_runs (run_id, step_id, round)`.execute(db);
    await sql`drop index workflow_step_runs_step_unique`.execute(db);

    await sql`alter table workflow_step_runs drop constraint workflow_step_runs_kind_check`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add constraint workflow_step_runs_kind_check
      check (kind in ('agent', 'action', 'if', 'loop'))`.execute(db);
    await sql`alter table workflow_step_runs drop constraint workflow_step_runs_status_check`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add constraint workflow_step_runs_status_check
      check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped'))`.execute(
      db,
    );
    await sql`alter table workflow_step_runs drop constraint workflow_step_runs_end_check`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add constraint workflow_step_runs_end_check
      check ((status in ('succeeded', 'failed', 'skipped')) = (finished_at is not null)
        and (status = 'failed' or error_code is null))`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table workflow_step_runs drop constraint workflow_step_runs_end_check`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add constraint workflow_step_runs_end_check
      check ((status in ('succeeded', 'failed')) = (finished_at is not null)
        and (status = 'failed' or error_code is null))`.execute(db);
    await sql`alter table workflow_step_runs drop constraint workflow_step_runs_status_check`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add constraint workflow_step_runs_status_check
      check (status in ('pending', 'running', 'succeeded', 'failed'))`.execute(
      db,
    );
    await sql`alter table workflow_step_runs drop constraint workflow_step_runs_kind_check`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add constraint workflow_step_runs_kind_check
      check (kind in ('agent', 'action'))`.execute(db);
    await sql`create unique index workflow_step_runs_step_unique
      on workflow_step_runs (run_id, step_id)`.execute(db);
    await sql`drop index workflow_step_runs_round_unique`.execute(db);
    await sql`alter table workflow_step_runs drop constraint workflow_step_runs_round_check`.execute(
      db,
    );
    await sql`alter table workflow_step_runs drop column round`.execute(db);
  },
};
