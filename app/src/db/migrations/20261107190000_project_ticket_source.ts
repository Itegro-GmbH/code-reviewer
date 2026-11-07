// SPDX-License-Identifier: LicenseRef-Proprietary

// The project as one ticket source (#922, epic #915). Two columns, a new rule for the name of a lane, and the backfills:
//  - `projects.ticket_source`: JSON text `{ "provider": "github", "repositoryId", "board": { "projectV2Id", "statusFieldId" } | null }`,
//    the GitHub issues of one repository and the optional GitHub Project that is their board. A project row is one per repository
//    (`repository_id` is unique), so `repositoryId` is that repository; the column holds what the repository cannot: the board. It is
//    null for every project that exists and code reads null as "the issues of the repository, no board" (no backfill: the column is
//    written when a project is created in the factory; no route sets the board of a project that exists, that is #937).
//  - `workflows.project_id`: the project a lane belongs to. Nullable at the database (an archived lane that no project could take stays
//    without one, and so does a lane an older version writes while this one is being deployed); the service requires it for every lane it
//    creates, and a lane without a project starts no run from a label.
//  - `tracker_items.project_id` and `tracker_sync_state.project_id` (reserved by #923, no foreign key) point at the project of their
//    repository.
//  - the name of a lane (`workflows_workspace_name_unique`, same name) is unique within its project and no longer within the workspace (the built-in lanes are copied into every project
//    under the same names); lanes without a project keep the old rule among themselves (`coalesce(project_id, '')`), which is what the
//    version that is still running writes.
//
// Backfills of the lanes and of the mirror's `project_id`. Lanes: a workflow that is not archived goes to the project of the repository
// its newest run used, an active project before an inactive one (the label trigger serves only active projects), the newest run first
// among equals; a lane that can only go to an inactive project is placed there and listed in the log; one that never ran goes to the
// only active project of its workspace; one that cannot be placed is archived and listed in the log of the migration (name, id and
// workspace, one line each), so that an owner can write it again in the project it belongs to. A lane an older version writes after
// the migration has run stays without a project (docs/workflows.md, "Lanes belong to a project").
//
// Expand only, safe for the version that is still running (it never reads the new columns, and the lanes it writes stay without a project):
//  - two nullable columns without a default are added, which Postgres does without rewriting the tables; the foreign key of `project_id`
//    is added `not valid` and validated afterwards, so it does not scan `workflows` under the lock;
//  - the wait for the locks is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`)
//    and the deployment can be run again.
//
// `down` drops the columns; the lanes it archived stay archived.
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

    await sql`alter table projects add column if not exists ticket_source text`.execute(
      db,
    );
    await sql`alter table projects drop constraint if exists projects_ticket_source_check`.execute(
      db,
    );
    await sql`alter table projects add constraint projects_ticket_source_check
      check (ticket_source is null or char_length(ticket_source) <= 4096) not valid`.execute(
      db,
    );
    await sql`alter table projects validate constraint projects_ticket_source_check`.execute(
      db,
    );

    await sql`alter table workflows add column if not exists project_id text`.execute(
      db,
    );
    await sql`alter table workflows drop constraint if exists workflows_project_id_fkey`.execute(
      db,
    );
    await sql`alter table workflows add constraint workflows_project_id_fkey
      foreign key (project_id) references projects (id) not valid`.execute(db);
    await sql`alter table workflows validate constraint workflows_project_id_fkey`.execute(
      db,
    );
    await sql`create index if not exists workflows_project_index
      on workflows (project_id) where project_id is not null`.execute(db);

    // One name once per project among the lanes that are not archived, whatever its case: the same index under the same name, with the
    // project in it (the migrations of a batch run in one transaction, so no name is unprotected in between). The names were unique in
    // the workspace, so they are unique in every project the backfill picks.
    await sql`drop index if exists workflows_workspace_name_unique`.execute(db);
    await sql`create unique index workflows_workspace_name_unique
      on workflows (workspace_id, coalesce(project_id, ''), lower(name)) where archived_at is null`.execute(
      db,
    );

    // The lanes: the project of the repository the newest run used (an active project before an inactive one), else the only active
    // project of the workspace.
    const placedByRuns = await sql<{
      id: string;
      name: string;
      workspace_id: string;
      active: number;
    }>`update workflows w
      set project_id = placed.project_id
      from (
        select distinct on (r.workflow_id) r.workflow_id, p.id as project_id, p.active
        from workflow_runs r
        join projects p on p.repository_id = r.repository_id
        join repositories repo on repo.id = p.repository_id
        join workflows own on own.id = r.workflow_id and own.workspace_id = repo.workspace_id
        order by r.workflow_id, p.active desc, r.created_at desc, r.id desc
      ) placed
      where w.id = placed.workflow_id
        and w.project_id is null
        and w.archived_at is null
      returning w.id, w.name, w.workspace_id, placed.active`.execute(db);
    for (const row of placedByRuns.rows)
      if (row.active !== 1)
        console.warn(
          `[migration] 20261107190000_project_ticket_source placed the workflow ${row.id} "${row.name.slice(0, 100)}" of workspace ${row.workspace_id} in an inactive project: no label starts it until the project is switched on (#922).`,
        );
    await sql`update workflows w
      set project_id = only_project.project_id
      from (
        select repo.workspace_id, min(p.id) as project_id
        from projects p
        join repositories repo on repo.id = p.repository_id
        where p.active = 1
        group by repo.workspace_id
        having count(*) = 1
      ) only_project
      where w.workspace_id = only_project.workspace_id
        and w.project_id is null
        and w.archived_at is null`.execute(db);

    const unplaced = await sql<{
      id: string;
      name: string;
      workspace_id: string;
    }>`select id, name, workspace_id from workflows
      where project_id is null and archived_at is null
      order by workspace_id, created_at, id`.execute(db);
    if (unplaced.rows.length > 0) {
      const timestamp = new Date().toISOString();
      await sql`update workflows
        set archived_at = ${timestamp}, updated_at = ${timestamp}
        where project_id is null and archived_at is null`.execute(db);
      for (const row of unplaced.rows)
        console.warn(
          `[migration] 20261107190000_project_ticket_source archived the workflow ${row.id} "${row.name.slice(0, 100)}" of workspace ${row.workspace_id}: no project could take it (#922).`,
        );
    }

    await sql`update tracker_items t
      set project_id = p.id
      from projects p
      where p.repository_id = t.repository_id and t.project_id is null`.execute(
      db,
    );
    await sql`update tracker_sync_state s
      set project_id = p.id
      from projects p
      where p.repository_id = s.repository_id and s.project_id is null`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    // Fails when two lanes of different projects share a name: those have to be renamed first.
    await sql`drop index if exists workflows_workspace_name_unique`.execute(db);
    await sql`create unique index workflows_workspace_name_unique
      on workflows (workspace_id, lower(name)) where archived_at is null`.execute(
      db,
    );
    await sql`drop index if exists workflows_project_index`.execute(db);
    await sql`alter table workflows drop constraint if exists workflows_project_id_fkey`.execute(
      db,
    );
    await sql`alter table workflows drop column if exists project_id`.execute(
      db,
    );
    await sql`alter table projects drop constraint if exists projects_ticket_source_check`.execute(
      db,
    );
    await sql`alter table projects drop column if exists ticket_source`.execute(
      db,
    );
  },
};
