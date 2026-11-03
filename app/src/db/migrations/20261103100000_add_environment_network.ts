// SPDX-License-Identifier: LicenseRef-Proprietary

// The environment's rule for the agent's network (#745, step 7): `network_mode` (`off`, `list`, `open`) and `network_hosts` (the
// host names of a list, one on each line) on `implementer_environments`, and their copy on the turn (`implementer_turns`), which
// takes its own snapshot of the environment when it starts (no foreign key: editing or deleting an environment touches no turn).
//
// Expand only, safe for the version that is still running (it never reads or writes these columns) and for the live database:
//  - `implementer_environments` gets two columns with a constant default (`off` and the empty text), which Postgres adds without
//    rewriting the table; every existing environment reads `off`, which is what the agent had before (no network). The table is
//    small and is read by the environments page only;
//  - `implementer_turns` gets two nullable columns without a default; every existing turn reads null, which is `off` too;
//  - the checks are plain `add constraint`: they scan the table once under the lock the `add column` already holds until the batch
//    commits. Both tables are small (a row for each environment, a row for each task, a few thousand at most), so the scan is
//    milliseconds; the bound below covers the wait for a writer, not the scan.
//  - `add column` takes a short exclusive lock on its table. The wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the
//    whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can simply be run again.
//
// The checks hold what the database can hold without knowing the rules of a host name (the app checks those and says which rule
// broke): the mode is one of the three, a list has hosts and the other modes have none, and the hosts are at most 100 lines of at
// most 253 characters (so at most 25,400 bytes of ASCII, which the app writes: punycode, lower case).
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
      add column network_mode text not null default 'off',
      add column network_hosts text not null default ''`.execute(db);
    await sql`alter table implementer_environments add constraint implementer_environments_network_check check (
        network_mode in ('off', 'list', 'open')
        and (network_mode = 'list') = (network_hosts <> '')
        and octet_length(network_hosts) <= 25400
      )`.execute(db);

    await sql`alter table implementer_turns
      add column environment_network_mode text,
      add column environment_network_hosts text`.execute(db);
    // Both or neither: a turn that was written before the rule existed has neither and reads `off`.
    await sql`alter table implementer_turns add constraint implementer_turns_environment_network_check check (
        (environment_network_mode is null and environment_network_hosts is null)
        or (
          environment_network_mode is not null
          and environment_network_mode in ('off', 'list', 'open')
          and environment_network_hosts is not null
          and (environment_network_mode = 'list') = (environment_network_hosts <> '')
          and octet_length(environment_network_hosts) <= 25400
        )
      )`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table implementer_turns drop constraint implementer_turns_environment_network_check`.execute(
      db,
    );
    await sql`alter table implementer_turns
      drop column environment_network_hosts,
      drop column environment_network_mode`.execute(db);
    await sql`alter table implementer_environments drop constraint implementer_environments_network_check`.execute(
      db,
    );
    await sql`alter table implementer_environments
      drop column network_hosts,
      drop column network_mode`.execute(db);
  },
};
