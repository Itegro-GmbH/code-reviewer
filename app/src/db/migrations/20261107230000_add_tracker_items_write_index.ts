// SPDX-License-Identifier: LicenseRef-Proprietary

// The ticket mirror's `lastWriteAt` (#937, epic #915): `max(synced_at)` of a repository's rows, which the issue list reads on every poll.
// Without an index it reads every row of the repository each time; with `(workspace_id, repository_id, synced_at desc)` it is the first
// entry of the index.
//
// Expand only, safe for the version that is still running (it never reads the index, and no column changes): `tracker_items` is a table
// of a day-old feature, so the index build is short only because the table is small and new: it holds the lock while it builds, so a
// table of millions of rows would need `create index concurrently` outside a transaction. The wait for the lock is bounded like the other
// migrations of the batch: after `LOCK_TIMEOUT` the migration gives up, the batch is rolled back (`MIGRATION_FAILED`) and the deployment
// can be run again.
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

    await sql`create index if not exists tracker_items_written_index
      on tracker_items (workspace_id, repository_id, synced_at desc)`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`drop index if exists tracker_items_written_index`.execute(db);
  },
};
