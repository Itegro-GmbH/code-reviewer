// SPDX-License-Identifier: LicenseRef-Proprietary

// #1053: how many MCP calls the Worker of a claim made through the Worker API's MCP route. Like `worker_fetches` (#320) the counter is on the
// job row next to the lease token it belongs to, and the claim resets it, so a job that is claimed again starts at zero. The route counts a
// call in one statement and refuses past a cap, so a runaway agent cannot turn the app into an unbounded caller of someone else's server.
//
// Expand only, safe for the version that is still running (it never reads or writes the column; its claim leaves the count where it is,
// and an older instance's insert takes the default) and for the live database: one column with a constant default, which Postgres adds
// without rewriting the table, and no check (a check would scan `jobs`, the biggest table, under the lock). Existing rows hold 0.
//
// The wait for the lock is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and
// the deployment can simply be run again. `down` drops the column.
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

    await sql`alter table jobs add column mcp_calls integer not null default 0`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table jobs drop column mcp_calls`.execute(db);
  },
};
