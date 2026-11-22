// SPDX-License-Identifier: LicenseRef-Proprietary

// A step on a self-hosted runner carries its own setup script and network rule since #1126 (ADR 0007, decision 11 as amended), and a turn
// copies them like a hosted turn does. The columns are the ones every turn already has (`environment_setup_script`,
// `environment_network_*`); what changes is the check of the runner copy, which required an empty script.
//
// Expand only, safe for the version that is still running: the check gets looser, so every row the old version writes (a runner copy with
// an empty script) is still allowed, and the old version never reads a script of a runner copy. `alter table` takes a short exclusive lock;
// the wait is bounded and the batch rolls back if it is not had (`MIGRATION_FAILED`), so the deployment can simply be run again.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** How long the migration waits for a lock before it gives up. */
export const LOCK_TIMEOUT = "5s";

export const migration: Migration = {
  async up(db) {
    const { rows } = await sql<{
      value: string;
    }>`select current_setting('lock_timeout') as value`.execute(db);
    const before = rows[0]?.value ?? "0";
    await sql`set local lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(db);

    await sql`alter table implementer_turns drop constraint implementer_turns_environment_check`.execute(
      db,
    );
    // As before, but a runner copy may hold a script of at most 64 KB, as a hosted copy does.
    await sql`alter table implementer_turns add constraint implementer_turns_environment_check check (
        (environment_id is null and environment_name is null and environment_vcpus is null and environment_setup_script is null
          and environment_kind is null and environment_labels is null)
        or (environment_id is not null and environment_name is not null and environment_vcpus is not null and environment_vcpus >= 1
            and environment_setup_script is not null and octet_length(environment_setup_script) <= 65536
            and (environment_kind is null or environment_kind = 'hosted') and environment_labels is null)
        or (environment_id is not null and environment_name is not null and environment_vcpus is null
            and environment_setup_script is not null and octet_length(environment_setup_script) <= 65536
            and environment_kind = 'runner'
            and environment_labels is not null and environment_labels <> '' and octet_length(environment_labels) <= 1000)
      )`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    // A runner copy with a script cannot be kept by the old check: the script is dropped from the copy (the turn was written; the
    // runner has it or not by now).
    await sql`update implementer_turns set environment_setup_script = ''
      where environment_kind = 'runner' and environment_setup_script <> ''`.execute(
      db,
    );
    await sql`alter table implementer_turns drop constraint implementer_turns_environment_check`.execute(
      db,
    );
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
  },
};
