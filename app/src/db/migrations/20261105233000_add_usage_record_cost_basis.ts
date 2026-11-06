// SPDX-License-Identifier: LicenseRef-Proprietary

// How the cost of a settled usage record is to be read (#856): a turn that ran on the login of a customer's device has no cost, but not
// because the runner could not measure it. `usage_records.cost_basis` is `subscription` for such a record and null for every other, so
// the counts of unknown costs and their alert (#361, #385) leave it out. Nothing is written by this migration; every record written
// before it, and every one a release that does not know the column writes, reads null, as it did.
//
// Expand only, safe for the version that is still running (it never reads or writes the column) and for the live database:
//  - one nullable column without a default is added, which Postgres does without rewriting the table;
//  - the check is a plain `add constraint`: it scans the table once, under the lock the `add column` already holds, and every row
//    is null, so the scan only reads;
//  - the wait for the lock is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back
//    (`MIGRATION_FAILED`) and the deployment can be run again.
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

    await sql`alter table usage_records add column cost_basis text`.execute(db);
    await sql`alter table usage_records add constraint usage_records_cost_basis_check check (
        cost_basis is null or cost_basis = 'subscription'
      )`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table usage_records drop constraint usage_records_cost_basis_check`.execute(
      db,
    );
    await sql`alter table usage_records drop column cost_basis`.execute(db);
  },
};
