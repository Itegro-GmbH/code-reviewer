// SPDX-License-Identifier: LicenseRef-Proprietary

// A run that a label starts has no person (#845, agent workflows, milestone 4). `workflow_runs` gets
//  - `trigger_kind`: what started the run, `manual` (a person, by hand) or `github.issueLabeled` (a label on an issue). Every run
//    that exists was started by hand, so the default is `manual`;
//  - `created_by` may be null: a run that a label started has no starter. The login of the person who put the label on stays in
//    `actor_login` (display only, as for a run started by hand), and the check below holds the rule: only a run started by hand
//    needs a user.
//
// Expand only, safe for the version that is still running (it reads `created_by` as text and never sees a run of a label, which
// only the new version starts) and for the live database:
//  - `drop not null` and `add column ... default 'manual'` change the catalog only; Postgres does not rewrite the table (a constant
//    default is stored once, not in the rows);
//  - both take a short exclusive lock on `workflow_runs`, a table of one row per run. The wait is bounded: after `LOCK_TIMEOUT` the
//    migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the check is a plain `add constraint`: it scans the table once under the lock the statements before already hold. Every row
//    that exists is `manual` with a user, so it holds.
//
// `down` puts `not null` back, which Postgres refuses while a run of a label exists: take those runs away first.
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

    await sql`alter table workflow_runs alter column created_by drop not null`.execute(
      db,
    );
    await sql`alter table workflow_runs add column trigger_kind text not null default 'manual'`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_trigger_check check (
        trigger_kind in ('manual', 'github.issueLabeled')
        and (trigger_kind <> 'manual' or created_by is not null)
      )`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table workflow_runs drop constraint workflow_runs_trigger_check`.execute(
      db,
    );
    await sql`alter table workflow_runs drop column trigger_kind`.execute(db);
    await sql`alter table workflow_runs alter column created_by set not null`.execute(
      db,
    );
  },
};
