// SPDX-License-Identifier: LicenseRef-Proprietary

// A ticket is named by a text key, and a mirror row by `(repository, provider, key)` (#1035, epic #1034: Jira Cloud as a ticket source).
// Today the key of a GitHub issue is its number as text (`15`); a Jira ticket will be `PROJ-123`. Two changes, both expand only:
//  - `tracker_items.key`: the text key of the ticket, with a unique index `(repository_id, provider, key)` next to the primary key
//    `(repository_id, number)`, which stays. The key of every row that exists is its number as text (backfilled here); a trigger fills it
//    in for a row the version that is still running inserts without one (it knows no key), so no row is ever without it and the column
//    can become NOT NULL, and the old primary key go, in a later release once no version writes by number. The column is nullable until then;
//    the new code writes it itself.
//  - `tracker_sync_state.provider`: which provider's tickets the row is the sync state of, `github` for every row that exists (a constant
//    default, which Postgres adds without rewriting the table), with a unique index `(repository_id, provider)` next to the primary key
//    `repository_id`, which stays.
// `workflow_runs.ticket_ref` (`github:owner/repo#128`) is not touched: its form is `<provider>:<locator>` for every provider already, and
// `128` is the key.
//
// Safe for the version that is still running (it never reads the new columns, and what it writes keeps working: the key is filled in by
// the trigger, the provider by the default) and for the live database:
//  - every pending migration runs in ONE transaction (`db/migrate.ts`), so the `ACCESS EXCLUSIVE` lock the first `alter table` takes on
//    `tracker_items` is held through the backfill, the constraint check and the index build below, and no `not valid` / `validate` or
//    `create index concurrently` split would shorten that (a concurrent index cannot run in a transaction at all). That is acceptable
//    because the tables are tiny: measured on the live databases on 2026-11-14 (read-only `count(*)`), the code-review app holds 33
//    `tracker_items` and 0 `tracker_sync_state` rows, the factory app 16 and 1. A table of hundreds of thousands of rows would need
//    batches and an index built outside the transaction instead. The wait for the locks is bounded like the other migrations of the
//    batch: after `LOCK_TIMEOUT` the migration gives up, the batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again.
//
// `down` drops the trigger, the indexes, the constraint and the columns; the old keys are untouched, so the rows keep working.
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

    await sql`alter table tracker_items add column if not exists key text`.execute(
      db,
    );
    // A row the old version inserts has no key: the trigger gives it the number as text. It fires for the backfill below too.
    await sql`create or replace function tracker_items_fill_key() returns trigger
      language plpgsql as $$
      begin
        if new.key is null then
          new.key := new.number::text;
        end if;
        return new;
      end;
      $$`.execute(db);
    await sql`drop trigger if exists tracker_items_fill_key on tracker_items`.execute(
      db,
    );
    await sql`create trigger tracker_items_fill_key
      before insert or update on tracker_items
      for each row execute function tracker_items_fill_key()`.execute(db);
    await sql`update tracker_items set key = number::text where key is null`.execute(
      db,
    );
    await sql`alter table tracker_items drop constraint if exists tracker_items_key_check`.execute(
      db,
    );
    await sql`alter table tracker_items add constraint tracker_items_key_check
      check (key is null or char_length(key) between 1 and 128)`.execute(db);
    await sql`create unique index if not exists tracker_items_key_index
      on tracker_items (repository_id, provider, key)`.execute(db);

    await sql`alter table tracker_sync_state add column if not exists provider text not null default 'github'`.execute(
      db,
    );
    await sql`create unique index if not exists tracker_sync_state_provider_index
      on tracker_sync_state (repository_id, provider)`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`drop index if exists tracker_sync_state_provider_index`.execute(
      db,
    );
    await sql`alter table tracker_sync_state drop column if exists provider`.execute(
      db,
    );
    await sql`drop index if exists tracker_items_key_index`.execute(db);
    await sql`alter table tracker_items drop constraint if exists tracker_items_key_check`.execute(
      db,
    );
    await sql`drop trigger if exists tracker_items_fill_key on tracker_items`.execute(
      db,
    );
    await sql`drop function if exists tracker_items_fill_key()`.execute(db);
    await sql`alter table tracker_items drop column if exists key`.execute(db);
  },
};
