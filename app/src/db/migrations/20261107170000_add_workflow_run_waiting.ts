// SPDX-License-Identifier: LicenseRef-Proprietary

// A run that waits for a person (#920). An agent turn ends with `done` or with a question (`ask`); a step whose turn asked is `waiting`, and
// so is its run, until somebody answers; the answer starts the next turn of the same session. What changes:
//  - `workflow_runs.status` and `workflow_step_runs.status` take `waiting`. A waiting run has no `finished_at`, so the end check of the run
//    reads `status in ('running', 'waiting')` where it read `status = 'running'`; the end check of a step already holds (only the three
//    final statuses have a `finished_at`);
//  - `workflow_step_runs.ask`: JSON text, the question of a step that asked and what became of it (`workflow-runs/ask.ts`); null for every
//    step that exists. `workflow_step_runs.waiting_on_comment_id`: the id of the comment that carries the question on the ticket or the
//    pull request, once it is posted; null otherwise;
//  - one run waits for one ticket as well as it runs for it: the partial unique index on (`workflow_id`, `trigger_key`) counts a `waiting`
//    run. The new index is built before the old one is dropped, so there is never a moment without the rule.
//
// Expand only, safe for the live database and for the version that is still running:
//  - the old version never writes `waiting`, `ask` or the comment id and never reads them; a run it advances is `running` as ever. A run the
//    new version put into `waiting` is left alone by its sweep (it looks at `running` runs only), so the deploy window cannot lose a
//    question; the old version does not list such a run as running, which only matters until the deployment is over;
//  - `add column` without a default changes the catalog only. It takes a short exclusive lock on each table; the wait is bounded: after
//    `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the checks are dropped and added again as plain `add constraint`s: each scans the table once under the lock the statements before
//    already hold, a row per run or per step, milliseconds. The size checks are added `not valid` and validated afterwards (the columns are
//    null in every row).
//
// `down` puts the old rules back, which Postgres refuses while a `waiting` run or step exists: take those runs away first.
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

    await sql`alter table workflow_runs drop constraint if exists workflow_runs_status_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_status_check
      check (status in ('running', 'waiting', 'succeeded', 'failed', 'cancelled'))`.execute(
      db,
    );
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_end_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_end_check
      check ((status in ('running', 'waiting')) = (finished_at is null)
        and (status = 'failed' or error_code is null))`.execute(db);

    await sql`create unique index if not exists workflow_runs_trigger_active_unique
      on workflow_runs (workflow_id, trigger_key)
      where status in ('running', 'waiting') and trigger_key is not null`.execute(
      db,
    );
    await sql`drop index if exists workflow_runs_trigger_running_unique`.execute(
      db,
    );

    await sql`alter table workflow_step_runs drop constraint if exists workflow_step_runs_status_check`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add constraint workflow_step_runs_status_check
      check (status in ('pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped'))`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add column if not exists ask text`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add column if not exists waiting_on_comment_id text`.execute(
      db,
    );
    await sql`alter table workflow_step_runs drop constraint if exists workflow_step_runs_ask_check`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add constraint workflow_step_runs_ask_check
      check ((ask is null or char_length(ask) <= 32768)
        and (waiting_on_comment_id is null or char_length(waiting_on_comment_id) <= 64)
        and (status <> 'waiting' or ask is not null)) not valid`.execute(db);
    await sql`alter table workflow_step_runs validate constraint workflow_step_runs_ask_check`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`create unique index if not exists workflow_runs_trigger_running_unique
      on workflow_runs (workflow_id, trigger_key)
      where status = 'running' and trigger_key is not null`.execute(db);
    await sql`drop index if exists workflow_runs_trigger_active_unique`.execute(
      db,
    );
    await sql`alter table workflow_step_runs drop constraint if exists workflow_step_runs_ask_check`.execute(
      db,
    );
    await sql`alter table workflow_step_runs drop column if exists waiting_on_comment_id`.execute(
      db,
    );
    await sql`alter table workflow_step_runs drop column if exists ask`.execute(
      db,
    );
    await sql`alter table workflow_step_runs drop constraint if exists workflow_step_runs_status_check`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add constraint workflow_step_runs_status_check
      check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped'))`.execute(
      db,
    );
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_end_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_end_check
      check ((status = 'running') = (finished_at is null)
        and (status = 'failed' or error_code is null))`.execute(db);
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_status_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_status_check
      check (status in ('running', 'succeeded', 'failed', 'cancelled'))`.execute(
      db,
    );
  },
};
