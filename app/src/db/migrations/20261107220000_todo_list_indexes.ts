// SPDX-License-Identifier: LicenseRef-Proprietary

// Indexes for the ToDo list (#924, epic #915), which reads three things of the runs: the runs that wait, the steps whose question was
// answered, and the action steps whose output names a pull request. Without them the last two are a scan of every step of the workspace
// with a text match; with them each is an ordered read of a small partial index, newest first, that stops at the limit:
//  - `workflow_runs_waiting_index` (`workspace_id, updated_at desc` where `status = 'waiting'`): the runs that wait for an answer;
//  - `workflow_step_runs_answered_ask_index` (`workspace_id, created_at desc` where the question holds an answer): only steps that were
//    answered are in it, a handful per run that asked;
//  - `workflow_step_runs_pull_request_index` (`workspace_id, created_at desc` where a succeeded action step's output names `/pull/`).
// The predicates are the text matches the queries use, written the same way (`runs-repository.ts`), so Postgres can prove a query is
// covered by the index; they are plain constants, which an index predicate needs.
//
// Expand only, safe for the version that is still running (it never uses them): `create index` takes a lock that blocks writes to the
// table while it builds. These tables hold the runs and steps of the factory, small and recent, so the build takes milliseconds; the wait
// for the lock is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the
// deployment can be run again. (`create index concurrently` cannot run in the transaction the batch runs in.)
//
// `down` drops the indexes.
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

    await sql`create index if not exists workflow_runs_waiting_index
      on workflow_runs (workspace_id, updated_at desc, id) where status = 'waiting'`.execute(
      db,
    );
    await sql`create index if not exists workflow_step_runs_answered_ask_index
      on workflow_step_runs (workspace_id, created_at desc, id)
      where ask is not null
        and (ask like '%"state":"answered"%' or ask like '%"state":"resumed"%')`.execute(
      db,
    );
    await sql`create index if not exists workflow_step_runs_pull_request_index
      on workflow_step_runs (workspace_id, created_at desc, id)
      where kind = 'action' and status = 'succeeded' and output like '%/pull/%'`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`drop index if exists workflow_step_runs_pull_request_index`.execute(
      db,
    );
    await sql`drop index if exists workflow_step_runs_answered_ask_index`.execute(
      db,
    );
    await sql`drop index if exists workflow_runs_waiting_index`.execute(db);
  },
};
