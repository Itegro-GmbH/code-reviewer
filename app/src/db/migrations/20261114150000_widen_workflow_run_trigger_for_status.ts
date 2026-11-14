// SPDX-License-Identifier: LicenseRef-Proprietary

// A move of a ticket into a status starts a run (#1036, epic #1034): `workflow_runs.trigger_kind` takes a new value, `ticket.statusChanged`.
// Nothing is written by this migration; every run written before it keeps its kind. Like the label trigger, a run of this kind has no
// person: only a run started by hand or through the API (`manual`, `api`) needs a user, which the check keeps.
//
// Safe for the version that is still running (it never writes `ticket.statusChanged`) and for the live database:
//  - the check is replaced inside one transaction under the lock `drop constraint` takes anyway; it is added `not valid` and validated
//    afterwards, so the scan runs under a weaker lock, as in `20261107110000_add_workflow_run_trigger_id`;
//  - the wait for the lock is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back
//    (`MIGRATION_FAILED`) and the deployment can be run again;
//  - the old version never reads a run of the new kind, but its sweep advances EVERY running run of the workspace, so during the deploy
//    window it can take up a run this version wrote shortly before it stopped. It finds no trigger of that kind in its validator and
//    the run most likely ends failed; it harms nothing, and the next move into the status starts a new one (as for a label, #845).
//
// `down` puts the old check back, which Postgres refuses while a run of the new kind exists: take those runs away first.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** How long the migration waits for a lock before it gives up. */
export const LOCK_TIMEOUT = "5s";

async function replaceCheck(
  db: Parameters<Migration["up"]>[0],
  kinds: string,
): Promise<void> {
  // `set local` ends with the transaction, but the migrations after this one in the same batch run in it too: put back what was set.
  const { rows } = await sql<{
    value: string;
  }>`select current_setting('lock_timeout') as value`.execute(db);
  const before = rows[0]?.value ?? "0";
  await sql`set local lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(db);

  await sql`alter table workflow_runs drop constraint workflow_runs_trigger_check`.execute(
    db,
  );
  await sql`alter table workflow_runs add constraint workflow_runs_trigger_check check (
      trigger_kind in (${sql.raw(kinds)})
      and (trigger_kind not in ('manual', 'api') or created_by is not null)
    ) not valid`.execute(db);
  await sql`alter table workflow_runs validate constraint workflow_runs_trigger_check`.execute(
    db,
  );

  await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
}

export const migration: Migration = {
  async up(db) {
    await replaceCheck(
      db,
      "'manual', 'api', 'ticket.labeled', 'ticket.statusChanged', 'github.issueLabeled', 'pullRequest.pushed', 'schedule'",
    );
  },

  async down(db) {
    await replaceCheck(
      db,
      "'manual', 'api', 'ticket.labeled', 'github.issueLabeled', 'pullRequest.pushed', 'schedule'",
    );
  },
};
