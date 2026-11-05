// SPDX-License-Identifier: LicenseRef-Proprietary

// Where the cost of a workflow step comes from (#873): `workflow_step_runs` gets `cost_basis`, which says whether the cost charged to a
// step is the figure the runner reported, an estimate from the token counts at the catalog price, or the whole cap the turn ran under.
// The run page shows it, so a person can tell a measured cost from a charged limit. A step that was not charged anything (an action,
// a step that never started a turn) and every step written before this migration read null.
//
// Expand only, safe for the version that is still running (it never reads or writes the column) and for the live database:
//  - one nullable column without a default is added, which Postgres does without rewriting the table; no existing row, index or
//    constraint changes;
//  - `add column` takes a short exclusive lock on `workflow_step_runs`. The wait is bounded: after `LOCK_TIMEOUT` the migration gives
//    up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the check is a plain `add constraint`: it scans the table once under the lock the `add column` already holds, a row per step of
//    a run that started by hand, milliseconds.
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

    await sql`alter table workflow_step_runs add column cost_basis text`.execute(
      db,
    );
    await sql`alter table workflow_step_runs add constraint workflow_step_runs_cost_basis_check check (
        cost_basis is null or (cost_basis in ('reported', 'estimated', 'limit') and cost_micro_usd is not null)
      )`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table workflow_step_runs drop constraint workflow_step_runs_cost_basis_check`.execute(
      db,
    );
    await sql`alter table workflow_step_runs drop column cost_basis`.execute(
      db,
    );
  },
};
