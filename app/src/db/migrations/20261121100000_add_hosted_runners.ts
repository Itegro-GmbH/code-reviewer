// SPDX-License-Identifier: LicenseRef-Proprietary

// The concrete runners of a lane step (#1105, epic #1103, ADR 0007, release A): a step names one runner by its id, and a runner is
// either a self-hosted one (`runners`) or a **hosted runner**, one type of the provided Vercel Sandbox. A hosted runner is a row of
// `implementer_environments` of the kind `hosted` that has a `concurrency` (how many turns it may run at the same time); its `vcpus` is the
// fixed size of its type. No new table.
//
// Expand only, safe for the version that is still running (it never reads or writes the new column, and every row it writes is an
// environment of its own, which is what a null `concurrency` says) and for the live database:
//  - `implementer_environments` gets the nullable column `concurrency` (no default, so no rewrite) and `created_by` loses NOT NULL: the
//    hosted runners are made by the platform, as `workspaces.created_by` already may be null. A foreign key stays;
//  - the rows are made here, for every workspace that is not deleted and every size the platform offers an environment
//    (`support/hosted-runner-rules.ts`, a frozen copy of `environmentVcpus` of `contracts/environment-sizes.v1.json`), with the concurrency the
//    operator set (`HOSTED_RUNNER_DEFAULT_CONCURRENCY`, else 2). Asked again it makes nothing (one row for each type and workspace). A name
//    that is taken in the workspace (an environment of its own, or a runner that is not revoked, named "Vercel Sandbox 4 vCPU") is
//    not taken from its owner: the hosted runner then gets " (hosted)" after it, or " (hosted " and the first eight characters of the workspace id ")"
//    if that is taken too, so one workspace's name can never fail the batch of all). A workspace made later gets its rows with the workspace;
//    a workspace that lacks one (see "The rollout window") gets it when its runners are read (`NamedRunnersRepository.list`);
//  - the names of the runners that are not revoked are made unique within a workspace, without regard to case (ADR 0007, "Names of
//    runners"): the older runner keeps its name, each later one with the same name gets " (" and the first eight characters of its id
//    ")" after it, and the runner is named in a notice of the migration. A revoked runner's name is free;
//  - two partial unique indexes: one hosted runner for each type and workspace (`concurrency is not null`), and one name for each
//    non-revoked runner and workspace. Both are built on small tables (a row for each environment or runner).
//  - `alter table` takes a short exclusive lock. The wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is
//    rolled back (`MIGRATION_FAILED`) and the deployment can simply be run again.
// The rollout window: the release that is still running while this one starts does not know the hosted rows. Until it is replaced it lists
// them as environments, counts them against its environment bound and lets `DELETE /environments/:id` remove one; a workspace it makes has
// none. That is accepted for the minutes of a rollout, because the hosted runners repair themselves: `NamedRunnersRepository.list` (read by
// the validator and the Setup page) makes a missing type again, under the workspace's lock. A type that was deleted gets a new id, so a
// step that named the old id is `runner_unknown` at the next save, as ADR 0007 decision 14 says for a runner that is gone.
// The name of a hosted runner is unique across both tables only in the service (a database cannot say it without a third table): this
// migration and the service that makes a runner or renames one take the same lock of the workspace.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";
import {
  HOSTED_RUNNER_MIGRATION_VCPUS,
  hostedRunnerMigrationConcurrency,
  hostedRunnerMigrationName,
} from "./support/hosted-runner-rules.ts";

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
      add column concurrency integer,
      alter column created_by drop not null`.execute(db);
    // Only a hosted environment can be a runner, and a hosted runner has a size (the kind check already holds that) and at least one place.
    await sql`alter table implementer_environments add constraint implementer_environments_concurrency_check check (
        concurrency is null or (kind = 'hosted' and concurrency >= 1)
      )`.execute(db);

    // The names of the runners that are not revoked: the oldest of the same name in a workspace keeps it.
    const renamed = await sql<{
      id: string;
      name: string;
      workspace_id: string;
    }>`
      with ranked as (
        select id, workspace_id, name,
               row_number() over (partition by workspace_id, lower(name) order by created_at, id) as place
          from runners
         where revoked_at is null
      )
      update runners
         set name = left(runners.name, 80 - 11) || ' (' || left(runners.id, 8) || ')'
        from ranked
       where runners.id = ranked.id and ranked.place > 1
      returning runners.id, runners.name, runners.workspace_id`.execute(db);
    // The list the ADR asks for: which runners were renamed, so nobody finds a changed name unexplained.
    for (const row of renamed.rows)
      console.info(
        `[migration] runner ${row.id} of workspace ${row.workspace_id} was renamed to "${row.name}": its name was taken`,
      );
    await sql`create unique index runners_workspace_name_unique
      on runners (workspace_id, lower(name)) where revoked_at is null`.execute(
      db,
    );
    await sql`create unique index implementer_environments_hosted_runner_unique
      on implementer_environments (workspace_id, vcpus) where concurrency is not null`.execute(
      db,
    );

    const concurrency = hostedRunnerMigrationConcurrency(process.env);
    for (const vcpus of HOSTED_RUNNER_MIGRATION_VCPUS) {
      const name = hostedRunnerMigrationName(vcpus);
      await sql`insert into implementer_environments
          (id, workspace_id, name, vcpus, setup_script, network_mode, network_hosts, kind, labels, created_by, created_at, updated_at, concurrency)
        select gen_random_uuid()::text, w.id,
               case when not exists (select 1 from implementer_environments e where e.workspace_id = w.id and lower(e.name) = lower(${name}))
                     and not exists (select 1 from runners r where r.workspace_id = w.id and r.revoked_at is null and lower(r.name) = lower(${name}))
                    then ${name}
                    when not exists (select 1 from implementer_environments e where e.workspace_id = w.id and lower(e.name) = lower(${`${name} (hosted)`}))
                     and not exists (select 1 from runners r where r.workspace_id = w.id and r.revoked_at is null and lower(r.name) = lower(${`${name} (hosted)`}))
                    then ${`${name} (hosted)`}
                    else ${`${name} (hosted `} || left(w.id, 8) || ')' end,
               ${vcpus}, '', 'off', '', 'hosted', '', null,
               to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               ${concurrency}
          from workspaces w
         where w.deleted_at is null
           and not exists (select 1 from implementer_environments h
                            where h.workspace_id = w.id and h.vcpus = ${vcpus} and h.concurrency is not null)`.execute(
        db,
      );
    }

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`drop index implementer_environments_hosted_runner_unique`.execute(
      db,
    );
    await sql`drop index runners_workspace_name_unique`.execute(db);
    await sql`delete from implementer_environments where concurrency is not null`.execute(
      db,
    );
    await sql`alter table implementer_environments drop constraint implementer_environments_concurrency_check`.execute(
      db,
    );
    // `created_by` stays nullable: a row made by a person has one, and putting NOT NULL back could fail on a row made meanwhile.
    await sql`alter table implementer_environments drop column concurrency`.execute(
      db,
    );
  },
};
