// SPDX-License-Identifier: LicenseRef-Proprietary

// A turn on the login of a customer's device is never billed, but the workflow budget counts Claude Code's estimate of it at API prices
// (#856): `workflow_step_runs.cost_basis` takes a fourth value, `subscription`, so the run page can say that the figure is an estimate of
// something that was not charged. Nothing is written by this migration; every step written before it keeps its basis.
//
// Safe for the version that is still running (it never writes `subscription`) and for the live database:
//  - the check is replaced inside one transaction under the lock `drop constraint` takes anyway; the table has a row per step of a
//    run that started by hand or by a label, so the scan of the new check takes milliseconds;
//  - the wait for the lock is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back
//    (`MIGRATION_FAILED`) and the deployment can be run again.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** How long the migration waits for a lock before it gives up. */
export const LOCK_TIMEOUT = "5s";

async function replaceCheck(
  db: Parameters<Migration["up"]>[0],
  bases: string,
): Promise<void> {
  // `set local` ends with the transaction, but the migrations after this one in the same batch run in it too: put back what was set.
  const { rows } = await sql<{
    value: string;
  }>`select current_setting('lock_timeout') as value`.execute(db);
  const before = rows[0]?.value ?? "0";
  await sql`set local lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(db);

  await sql`alter table workflow_step_runs drop constraint workflow_step_runs_cost_basis_check`.execute(
    db,
  );
  await sql`alter table workflow_step_runs add constraint workflow_step_runs_cost_basis_check check (
      cost_basis is null or (cost_basis in (${sql.raw(bases)}) and cost_micro_usd is not null)
    )`.execute(db);

  await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
}

export const migration: Migration = {
  async up(db) {
    await replaceCheck(db, "'reported', 'estimated', 'limit', 'subscription'");
  },

  async down(db) {
    // A step booked as an estimate of a subscription turn is an estimate; the old check has no other word for it.
    await sql`update workflow_step_runs set cost_basis = 'estimated' where cost_basis = 'subscription'`.execute(
      db,
    );
    await replaceCheck(db, "'reported', 'estimated', 'limit'");
  },
};
