// SPDX-License-Identifier: LicenseRef-Proprietary

// Indexes for the list of the lane runs of a workspace (#1078, epic #1077), which shows the runs that go on first and the others after
// them, each part newest first, and is read again every few seconds while a run is active. The repository reads the two parts one after
// the other (`listWorkspaceRuns`), so each is an ordered read of an index that stops at the limit instead of a sort of every run:
//  - `workflow_runs_active_index` (`workspace_id, created_at desc, id desc` where `status in ('running', 'waiting')`): the runs that go on;
//  - `workflow_runs_workspace_index` (`workspace_id, created_at desc, id desc`): the runs of a workspace newest first; the read of the
//    ended runs walks it from the newest one and filters by status, and the ended runs are nearly all of the table.
// The predicate is written as the query writes it (`status in ('running', 'waiting')`), so Postgres can prove the query is covered.
//
// Expand only, safe for the version that is still running (it never uses them): `create index` takes a lock that blocks writes to the
// table while it builds. The runs of the factory are few and recent, so the build takes milliseconds; the wait for the lock is bounded
// like in `20261107220000_todo_list_indexes`: after `LOCK_TIMEOUT` the migration gives up, the batch is rolled back and the deployment
// can be run again.
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

    await sql`create index if not exists workflow_runs_workspace_index
      on workflow_runs (workspace_id, created_at desc, id desc)`.execute(db);
    await sql`create index if not exists workflow_runs_active_index
      on workflow_runs (workspace_id, created_at desc, id desc)
      where status in ('running', 'waiting')`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`drop index if exists workflow_runs_active_index`.execute(db);
    await sql`drop index if exists workflow_runs_workspace_index`.execute(db);
  },
};
