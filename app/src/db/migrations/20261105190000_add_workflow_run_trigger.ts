// SPDX-License-Identifier: LicenseRef-Proprietary

// A run that a label starts has no person (#845, agent workflows, milestone 4). `workflow_runs` gets
//  - `trigger_kind`: what started the run, `manual` (a person, by hand) or `github.issueLabeled` (a label on an issue). Every run
//    that exists was started by hand, so the default is `manual`;
//  - `created_by` may be null: a run that a label started has no starter. The login of the person who put the label on stays in
//    `actor_login` (display only, as for a run started by hand), and the check below holds the rule: only a run started by hand
//    needs a user;
//  - `trigger_key`: what a trigger started the run for, `<repository id>#<issue number>` for a label (null for a run by hand). The
//    partial unique index on (`workflow_id`, `trigger_key`) where the run is `running` lets a workflow have one running run for one
//    issue: putting a label on, taking it off and putting it on again while the first run goes on starts nothing, and two deliveries
//    that race for it cannot both write a run. A run that has ended frees the issue for the next label.
//
// Expand only, safe for the live database and for the version that is still running, except for one case in the deploy window:
//  - the old version never starts a run of a label and never reads `trigger_kind` or `trigger_key`, but its sweep advances EVERY
//    running run of the workspace, so it can take up a run of a label that the new version wrote shortly before the old one stopped.
//    The old engine hands `created_by`, which is null for that run, to the Implementer as the owner of the session. It was never
//    written for that, so the outcome is not promised: the agent step most likely cannot start and the run ends failed. The run is
//    lost and harms nothing, and the label can be put on again once the new version is up (the failed run frees the issue);
//  - `drop not null` and `add column ... default 'manual'` change the catalog only; Postgres does not rewrite the table (a constant
//    default is stored once, not in the rows);
//  - both take a short exclusive lock on `workflow_runs`, a table of one row per run. The wait is bounded: after `LOCK_TIMEOUT` the
//    migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the partial index holds only rows with a `trigger_key`, and no row has one yet, so building it is a catalog change in effect;
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
    await sql`alter table workflow_runs add column trigger_key text`.execute(
      db,
    );
    await sql`create unique index workflow_runs_trigger_running_unique
      on workflow_runs (workflow_id, trigger_key)
      where status = 'running' and trigger_key is not null`.execute(db);
    await sql`alter table workflow_runs add constraint workflow_runs_trigger_check check (
        trigger_kind in ('manual', 'github.issueLabeled')
        and (trigger_kind <> 'manual' or created_by is not null)
      )`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`drop index workflow_runs_trigger_running_unique`.execute(db);
    await sql`alter table workflow_runs drop column trigger_key`.execute(db);
    await sql`alter table workflow_runs drop constraint workflow_runs_trigger_check`.execute(
      db,
    );
    await sql`alter table workflow_runs drop column trigger_kind`.execute(db);
    await sql`alter table workflow_runs alter column created_by set not null`.execute(
      db,
    );
  },
};
