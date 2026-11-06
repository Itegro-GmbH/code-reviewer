// SPDX-License-Identifier: LicenseRef-Proprietary

// How a workflow run ended while its `onFailure` steps run (#902). One nullable column:
//  - `workflow_runs.failure`: JSON text, set once when a run that would end `failed` or `cancelled` begins the steps of `onFailure`: the
//    status and error code the run ends with afterwards, and the facts those steps read (`{{failure.stepId}}`, `.code`, `.message`). The run
//    stays `running` meanwhile, so the sweep finds it and nothing about its end changes: the engine ends it with the status stored here.
//    Null for every run that exists, and for every run whose workflow has no `onFailure` steps.
//
// Expand only, safe for the live database and for the version that is still running:
//  - the old version never reads or writes the column, and a run it advances never has one;
//  - `add column` without a default changes the catalog only; Postgres does not rewrite the table. It takes a short exclusive lock on
//    `workflow_runs`; the wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back
//    (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the size check is added `not valid` and validated afterwards, so adding it does not scan the table under the exclusive lock; the
//    column is null in every row, so the validation passes at once.
//
// `down` drops the column and with it the facts of the runs that were failing.
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

    await sql`alter table workflow_runs add column if not exists failure text`.execute(
      db,
    );
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_failure_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_failure_check
      check (failure is null or char_length(failure) <= 4096) not valid`.execute(
      db,
    );
    await sql`alter table workflow_runs validate constraint workflow_runs_failure_check`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_failure_check`.execute(
      db,
    );
    await sql`alter table workflow_runs drop column if exists failure`.execute(
      db,
    );
  },
};
