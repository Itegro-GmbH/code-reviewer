// SPDX-License-Identifier: LicenseRef-Proprietary

// The environment kind `runner` (#854, R1a part 2): an environment either describes a VM of the platform (`hosted`: a size, a setup
// script and a network rule, as before) or names the labels a runner on a customer's machine must have (`runner`: labels instead of
// all three). The turn copies the kind and the labels with the rest of the environment, so the claim routes by its own row.
//
// Expand only, safe for the version that is still running (it never reads or writes these columns, and every row it writes is a
// hosted environment, which is what the defaults say) and for the live database:
//  - `implementer_environments` gets `kind` (default `hosted`) and `labels` (default empty, one label on each line); Postgres adds a
//    column with a constant default without rewriting the table. `vcpus` loses NOT NULL (a metadata change): a runner environment
//    has no size. Every existing row stays what it was: hosted, with its size, and no labels;
//  - `implementer_turns` gets two nullable columns without a default (`environment_kind`, `environment_labels`); every existing turn
//    reads null, which is hosted. Its all-or-none check on the environment copy is replaced by one that lets a runner turn carry no
//    size;
//  - the checks are plain `add constraint`: they scan the table once under the lock the `alter table` already holds until the batch
//    commits. Both tables are small (a row for each environment, a row for each task, a few thousand at most), so the scan is
//    milliseconds; the bound below covers the wait for a writer, not the scan.
//  - `alter table` takes a short exclusive lock. The wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is
//    rolled back (`MIGRATION_FAILED`) and the deployment can simply be run again.
//  - one partial index on the turns of the runner kind makes the claim's routing and the deadline pass cheap without touching the
//    others. It is built on a table of a few thousand rows.
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

    await sql`alter table implementer_environments
      add column kind text not null default 'hosted',
      add column labels text not null default '',
      alter column vcpus drop not null`.execute(db);
    // A hosted environment has a size and no labels; a runner environment has labels (at most 20 of at most 40 characters and a
    // line break) and none of the rest. The app checks the form of each label.
    await sql`alter table implementer_environments add constraint implementer_environments_kind_check check (
        (kind = 'hosted' and vcpus is not null and labels = '')
        or (kind = 'runner' and vcpus is null and labels <> '' and setup_script = '' and network_mode = 'off'
            and octet_length(labels) <= 1000)
      )`.execute(db);

    await sql`alter table implementer_turns
      add column environment_kind text,
      add column environment_labels text`.execute(db);
    await sql`alter table implementer_turns drop constraint implementer_turns_environment_check`.execute(
      db,
    );
    // All or none, as before, now with the kind: a turn written before the kind has none and is hosted; a hosted copy has a size and
    // no labels; a runner copy has labels and no size and no script.
    await sql`alter table implementer_turns add constraint implementer_turns_environment_check check (
        (environment_id is null and environment_name is null and environment_vcpus is null and environment_setup_script is null
          and environment_kind is null and environment_labels is null)
        or (environment_id is not null and environment_name is not null and environment_vcpus is not null and environment_vcpus >= 1
            and environment_setup_script is not null and octet_length(environment_setup_script) <= 65536
            and (environment_kind is null or environment_kind = 'hosted') and environment_labels is null)
        or (environment_id is not null and environment_name is not null and environment_vcpus is null
            and environment_setup_script = '' and environment_kind = 'runner'
            and environment_labels is not null and environment_labels <> '' and octet_length(environment_labels) <= 1000)
      )`.execute(db);
    await sql`create index implementer_turns_runner_job_idx
      on implementer_turns (job_id) where environment_kind = 'runner'`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`drop index implementer_turns_runner_job_idx`.execute(db);
    await sql`alter table implementer_turns drop constraint implementer_turns_environment_check`.execute(
      db,
    );
    await sql`alter table implementer_turns
      drop column environment_labels,
      drop column environment_kind`.execute(db);
    await sql`alter table implementer_turns add constraint implementer_turns_environment_check check (
        (environment_id is null and environment_name is null and environment_vcpus is null and environment_setup_script is null)
        or (environment_id is not null and environment_name is not null and environment_vcpus is not null and environment_vcpus >= 1
            and environment_setup_script is not null and octet_length(environment_setup_script) <= 65536)
      )`.execute(db);
    await sql`alter table implementer_environments drop constraint implementer_environments_kind_check`.execute(
      db,
    );
    await sql`delete from implementer_environments where kind = 'runner'`.execute(
      db,
    );
    await sql`alter table implementer_environments
      alter column vcpus set not null,
      drop column labels,
      drop column kind`.execute(db);
  },
};
