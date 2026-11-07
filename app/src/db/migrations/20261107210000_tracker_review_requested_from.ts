// SPDX-License-Identifier: LicenseRef-Proprietary

// Who a review of a pull request is asked from, in the ticket mirror (#924, epic #915): `tracker_items.review_requested_from`, JSON text
// `["login", ...]` as GitHub names the users of `requested_reviewers`. The ToDo list reads it to show an open pull request of a lane to the
// person who is asked. Null means the mirror was not told yet (a row written before, or by a delivery that carries no pull request); code
// reads null as nobody. The webhook (`pull_request`, `review_requested` and `review_request_removed` too: the object always carries the
// whole list) and the checks phase of the full sync (the list of the open pull requests) write it, so a rebuilt cache holds what a kept
// one holds.
//
// Expand only, safe for the version that is still running (it never reads the column): one nullable column without a default, which
// Postgres adds without rewriting the table; the wait for the lock is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole
// batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again. The size check is added `not valid` and validated
// afterwards (the column is null in every row).
//
// The same migration adds `review_acted_by` (JSON text `[{"login": "...", "sha": "..."}]`, null for none): who acted on a review ToDo of
// the pull request, and the head commit at that time, while the provider still holds a request that covers them (the App's review does
// not satisfy a person's request, and taking the request away can fail). The ToDo list hides the review from them. A mark is dropped on a
// new head commit, on close, or when a list says nobody is asked, never because its login is not in a list (a member of the fan-out is
// never asked by name).
//
// `down` drops the columns (the next sync fills the first one again from the provider).
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

    await sql`alter table tracker_items add column if not exists review_requested_from text`.execute(
      db,
    );
    await sql`alter table tracker_items drop constraint if exists tracker_items_review_requested_from_check`.execute(
      db,
    );
    await sql`alter table tracker_items add constraint tracker_items_review_requested_from_check
      check (review_requested_from is null or char_length(review_requested_from) <= 4096) not valid`.execute(
      db,
    );
    await sql`alter table tracker_items validate constraint tracker_items_review_requested_from_check`.execute(
      db,
    );

    await sql`alter table tracker_items add column if not exists review_acted_by text`.execute(
      db,
    );
    await sql`alter table tracker_items drop constraint if exists tracker_items_review_acted_by_check`.execute(
      db,
    );
    await sql`alter table tracker_items add constraint tracker_items_review_acted_by_check
      check (review_acted_by is null or char_length(review_acted_by) <= 4096) not valid`.execute(
      db,
    );
    await sql`alter table tracker_items validate constraint tracker_items_review_acted_by_check`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table tracker_items drop constraint if exists tracker_items_review_acted_by_check`.execute(
      db,
    );
    await sql`alter table tracker_items drop column if exists review_acted_by`.execute(
      db,
    );
    await sql`alter table tracker_items drop constraint if exists tracker_items_review_requested_from_check`.execute(
      db,
    );
    await sql`alter table tracker_items drop column if exists review_requested_from`.execute(
      db,
    );
  },
};
