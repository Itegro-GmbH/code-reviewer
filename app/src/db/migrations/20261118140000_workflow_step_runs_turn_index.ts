// SPDX-License-Identifier: LicenseRef-Proprietary

// An index for the turn of a lane step (#1080, epic #1077). A step keeps only its newest job and turn (`attachAnswerTurn` moves both to the
// follow-up turn of the same Implementer session when someone answers), so the agent run page of an older job finds its lane step through
// the session: the turn of the job, the turns of that session, the step that holds one of them. `workflow_step_runs.turn_id` had no index
// (only `job_id` has, `workflow_step_runs_job_unique`), so that last read would scan the table. The index is partial: a step has a turn
// only after an agent turn has been started.
//
// Expand only, safe for the version that is still running (it never uses it): `create index` takes a lock that blocks writes to the table
// while it builds. The steps of the factory are few and recent, so the build takes milliseconds; the wait for the lock is bounded like in
// `20261118120000_workflow_runs_workspace_list_indexes`: after `LOCK_TIMEOUT` the migration gives up, the batch is rolled back and the
// deployment can be run again.
//
// `down` drops the index.
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

    await sql`create index if not exists workflow_step_runs_turn_index
      on workflow_step_runs (turn_id) where turn_id is not null`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`drop index if exists workflow_step_runs_turn_index`.execute(db);
  },
};
