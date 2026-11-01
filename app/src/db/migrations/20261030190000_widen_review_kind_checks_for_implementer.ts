// SPDX-License-Identifier: LicenseRef-Proprietary

// #752 (part of #745): the checks on `usage_records.review_kind` and `billing_journal_entries.review_kind` allowed `diff` and
// `dynamic` only. A turn of the Implementer is a job of the kind `implementer`, its usage record and its journal entries carry
// that kind, so both checks take the third value. The list is `JOB_KINDS` in the code (src/job-kind/job-kind.ts).
//
// This runs on the live database of code-review.com too, and changes nothing there but the two definitions:
//  - no row, column or other constraint changes (the one index is described below). Every existing row satisfies the wider check,
//    so no row is looked at in a way that can fail;
//  - the old check is dropped and the wider one added under the same name in the same transaction, so there is no moment without
//    a check. `drop constraint` and `add constraint` take an exclusive lock on the table, which blocks its writers until the
//    batch commits, and `add constraint` reads every row once to validate. Both are bounded: `lock_timeout` makes the migration
//    give up (`MIGRATION_FAILED`, the whole batch rolled back, nothing half applied, the deployment can simply be run again)
//    instead of making the queue wait behind a long lock request, and `statement_timeout` bounds the read. The tables hold one
//    row per run (usage records) or per charge (the journal), so the read takes milliseconds;
//  - `billing_journal_entries` is append-only through triggers on UPDATE, DELETE and TRUNCATE; changing a constraint is none of
//    those and writes no entry;
//  - it can be run again: the drop is `if exists`, so a second `up` leaves the same two checks (the test runs it by hand).
// The order is the usage records first, then the journal: both are leaves (nothing references them), so neither takes a lock on a
// table the queue writes to (`jobs`).
//
// It also adds one partial index on `jobs`, `jobs_ended_after_claim (review_kind, finished_at) where claimed_at is not null`, last of
// all, so that waiting for a leaf table never holds `jobs`. The sweep that cancels a job with `no_capable_runner` asks, for each
// waiting job and under the exclusive gate lock of the queue, whether a job of the same kind ended after a claim within the deadline;
// without the index that is a scan of all jobs on every claim (the whole sweep took 888 ms with 100 000 jobs and 20 waiting, 1.3 ms with
// the index; the `running` half of the lookup uses the existing `jobs_status_run_after`, the planner joins both with a BitmapOr). Only the jobs a runner claimed are in it, so it stays small and costs a write only when a job ends. It is a plain
// `create index` (the migrator's transaction cannot take `CONCURRENTLY`): it blocks writes to `jobs` while it builds and, like any
// lock, until the batch commits; `lock_timeout` bounds the wait for the table (a long writer makes the migration give up like the
// checks above, the whole batch is rolled back and the deployment can be run again) and `statement_timeout` the build, which
// reads the table once. `if not exists` makes it safe to run again.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** How long the migration waits for a lock before it gives up. */
export const LOCK_TIMEOUT = "5s";
/** The longest one statement of it runs. */
export const STATEMENT_TIMEOUT = "30s";

const CHECKS = [
  {
    table: "usage_records",
    name: "usage_records_review_kind_check",
    wide: "review_kind in ('diff', 'dynamic', 'implementer')",
    narrow: "review_kind in ('diff', 'dynamic')",
  },
  {
    table: "billing_journal_entries",
    name: "billing_journal_entries_review_kind_check",
    wide: "review_kind is null or review_kind in ('diff', 'dynamic', 'implementer')",
    narrow: "review_kind is null or review_kind in ('diff', 'dynamic')",
  },
] as const;

type Db = Parameters<Migration["up"]>[0];

/** Runs `change` with both timeouts set for this transaction, and puts back what the session had (a later migration of the batch shares it). */
async function bounded(db: Db, change: () => Promise<void>): Promise<void> {
  const { rows } = await sql<{
    lock: string;
    statement: string;
  }>`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`.execute(
    db,
  );
  const before = rows[0] ?? { lock: "0", statement: "0" };
  await sql`set local lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(db);
  await sql`set local statement_timeout = ${sql.lit(STATEMENT_TIMEOUT)}`.execute(
    db,
  );
  await change();
  await sql`select set_config('lock_timeout', ${before.lock}, true), set_config('statement_timeout', ${before.statement}, true)`.execute(
    db,
  );
}

async function replace(
  db: Db,
  check: (typeof CHECKS)[number],
  definition: string,
  validated: boolean,
): Promise<void> {
  await sql`alter table ${sql.table(check.table)} drop constraint if exists ${sql.id(check.name)}`.execute(
    db,
  );
  await sql
    .raw(
      `alter table ${check.table} add constraint ${check.name} check (${definition})${validated ? "" : " not valid"}`,
    )
    .execute(db);
}

/** The index of the jobs a runner claimed and ended, per kind (#752). */
export const ENDED_AFTER_CLAIM_INDEX = "jobs_ended_after_claim";

export const migration: Migration = {
  async up(db) {
    await bounded(db, async () => {
      for (const check of CHECKS) await replace(db, check, check.wide, true);
      await sql`create index if not exists ${sql.id(ENDED_AFTER_CLAIM_INDEX)} on jobs (review_kind, finished_at) where claimed_at is not null`.execute(
        db,
      );
    });
  },

  async down(db) {
    // Rows of the kind `implementer` cannot be removed (the journal is append-only, a usage record belongs to its job), so the
    // narrow check is added `not valid`: it refuses new rows of the kind and leaves the ones that exist.
    await bounded(db, async () => {
      for (const check of CHECKS) await replace(db, check, check.narrow, false);
      await sql`drop index if exists ${sql.id(ENDED_AFTER_CLAIM_INDEX)}`.execute(
        db,
      );
    });
  },
};
