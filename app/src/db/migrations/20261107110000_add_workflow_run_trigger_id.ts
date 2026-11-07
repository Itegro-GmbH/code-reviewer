// SPDX-License-Identifier: LicenseRef-Proprietary

// A workflow has several triggers (#916), so a run records which one started it and the kinds a run can have grow.
//  - `workflow_runs.trigger_id`: the id of the trigger of the workflow document that started the run. Null for every run that exists:
//    they were started by the one trigger the document had, which the engine finds again by the kind (`trigger_kind`);
//  - `workflow_runs_trigger_check` takes the new kinds: `ticket.labeled` (what `github.issueLabeled` is called now; the old name stays
//    valid for the rows that have it and for documents that use it), `api`, and the reserved `pullRequest.pushed` and `schedule`. As
//    before, a run started by a person (`manual`, `api`) has a user.
//
// Expand only, safe for the live database and for the version that is still running:
//  - the old version never reads or writes `trigger_id` and never writes a new kind;
//  - `trigger_input` keeps the shape the old version reads: a run started by hand or through the API stores the input exactly as it was
//    handed in unless the trigger has a `ticket` input; only then is it `{ input, ticket }`, which a document the old version saved
//    cannot ask for. The old version therefore reads `{{trigger.input.repo}}` of every run the new one writes for such a document;
//  - `add column` without a default changes the catalog only; Postgres does not rewrite the table. It takes a short exclusive lock on
//    `workflow_runs`; the wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back
//    (`MIGRATION_FAILED`) and the deployment can be run again;
//  - both checks are added `not valid` and validated afterwards, so they do not scan the table under the exclusive lock. Every row that
//    exists is `manual` with a user or `github.issueLabeled`, and has no `trigger_id`, so both pass at once.
//
// `down` puts the old check back, which Postgres refuses while a run of a new kind exists: take those runs away first.
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

    await sql`alter table workflow_runs add column if not exists trigger_id text`.execute(
      db,
    );
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_trigger_id_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_trigger_id_check
      check (trigger_id is null or char_length(trigger_id) between 1 and 64) not valid`.execute(
      db,
    );
    await sql`alter table workflow_runs validate constraint workflow_runs_trigger_id_check`.execute(
      db,
    );

    await sql`alter table workflow_runs drop constraint workflow_runs_trigger_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_trigger_check check (
        trigger_kind in ('manual', 'api', 'ticket.labeled', 'github.issueLabeled', 'pullRequest.pushed', 'schedule')
        and (trigger_kind not in ('manual', 'api') or created_by is not null)
      ) not valid`.execute(db);
    await sql`alter table workflow_runs validate constraint workflow_runs_trigger_check`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table workflow_runs drop constraint workflow_runs_trigger_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_trigger_check check (
        trigger_kind in ('manual', 'github.issueLabeled')
        and (trigger_kind <> 'manual' or created_by is not null)
      )`.execute(db);
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_trigger_id_check`.execute(
      db,
    );
    await sql`alter table workflow_runs drop column if exists trigger_id`.execute(
      db,
    );
  },
};
