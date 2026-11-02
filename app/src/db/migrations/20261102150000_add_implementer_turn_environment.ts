// SPDX-License-Identifier: LicenseRef-Proprietary

// The environment a turn started with (#818): `implementer_turns` gets the snapshot of the environment the person chose, and
// `job_vm_runs` the size of the VM, so that minutes can be priced by size later. Both are copies, never references: editing or
// deleting an environment touches no turn (a delete cannot violate anything, because there is no foreign key).
//
// Expand only, safe for the version that is still running (it never reads or writes these columns) and for the live database:
//  - six nullable columns without a default are added, which Postgres does without rewriting a table; no existing row, index or
//    constraint changes, and every existing row reads null (no environment, size not recorded);
//  - `add column` takes a short exclusive lock on its table. `job_vm_runs` is written by every launch, so the wait is bounded: after
//    `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again.
//    The tables are altered in the order of their size, the small (`implementer_turns`) first;
//  - the two checks are plain `add constraint`: they scan the table once, under the lock the `add column` already holds until the
//    batch commits. Both tables are small (a row per task and a row per VM, a few thousand at most), so the scan is milliseconds;
//    the 5 second bound covers the wait for a writer, not the scan.
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

    for (const column of [
      "environment_id text",
      "environment_name text",
      "environment_vcpus integer",
      "environment_setup_script text",
    ])
      await sql
        .raw(`alter table implementer_turns add column ${column}`)
        .execute(db);
    // All or none: a turn has an environment (name, size and script) or it has not.
    await sql`alter table implementer_turns add constraint implementer_turns_environment_check check (
        (environment_id is null and environment_name is null and environment_vcpus is null and environment_setup_script is null)
        or (environment_id is not null and environment_name is not null and environment_vcpus is not null and environment_vcpus >= 1
            and environment_setup_script is not null and octet_length(environment_setup_script) <= 65536)
      )`.execute(db);

    await sql`alter table job_vm_runs add column vcpus integer`.execute(db);
    await sql`alter table job_vm_runs add constraint job_vm_runs_vcpus_check check (vcpus is null or vcpus >= 1)`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table job_vm_runs drop column vcpus`.execute(db);
    await sql`alter table implementer_turns drop constraint implementer_turns_environment_check`.execute(
      db,
    );
    for (const column of [
      "environment_setup_script",
      "environment_vcpus",
      "environment_name",
      "environment_id",
    ])
      await sql
        .raw(`alter table implementer_turns drop column ${column}`)
        .execute(db);
  },
};
