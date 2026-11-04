// SPDX-License-Identifier: LicenseRef-Proprietary

// The workflows of a workspace (#833, agent workflows, milestone 1): a workflow is a JSON document with a name, saved per workspace.
// Every save is a new, immutable version; `workflows` holds the name and which version is the current one, `workflow_versions`
// holds the documents. A workflow is never deleted by the user: it is archived (`archived_at`), which hides it from the list, gives its
// name back and counts it no more against the workspace's maximum; its versions stay. The tables are new and empty and nothing else points at them yet (the engine of a later milestone will
// point at a version).
//
// Expand only, safe for the version that is still running (it never reads the tables) and for the live database:
//  - two tables are added; no column, row or index of an existing table changes, and nothing is taken from `jobs`;
//  - the tables have foreign keys to `workspaces` and (`workflows`) `users`, which take a short lock on those tables. The wait is bounded: after
//    `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can simply be
//    run again. A writer that waited behind a long lock request would be worse than a failed deployment.
//  - `workflow_versions.workspace_id` repeats the workspace of the workflow, so every query of a version can filter by the
//    workspace itself (docs: workspace scoping) and the erasure of a workspace needs no join.
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

    await db.schema
      .createTable("workflows")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("current_version", "integer", (column) => column.notNull())
      .addColumn("created_by", "text", (column) =>
        column.notNull().references("users.id"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      // ISO 8601 UTC, set when the workflow is archived.
      .addColumn("archived_at", "text")
      .addCheckConstraint(
        "workflows_name_check",
        sql`char_length(name) between 1 and 100`,
      )
      .addCheckConstraint(
        "workflows_current_version_check",
        sql`current_version >= 1`,
      )
      .execute();

    // One name once per workspace among the workflows that are not archived, whatever its case.
    await sql`create unique index workflows_workspace_name_unique
      on workflows (workspace_id, lower(name)) where archived_at is null`.execute(
      db,
    );

    await db.schema
      .createTable("workflow_versions")
      .addColumn("workflow_id", "text", (column) =>
        column.notNull().references("workflows.id"),
      )
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      // The JSON text as it was validated and saved. 256 KB of UTF-8, the bound of the format.
      .addColumn("document", "text", (column) => column.notNull())
      // Who saved this version, as the user id it had then. No foreign key: a version is history the database refuses to change, and
      // merging the instance admin with an imported operator retires the operator's user row (src/github-signin/merge.ts), which a
      // foreign key would forbid and the immutable row cannot be re-pointed away from.
      .addColumn("created_by", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("workflow_versions_pkey", [
        "workflow_id",
        "version",
      ])
      .addCheckConstraint("workflow_versions_version_check", sql`version >= 1`)
      .addCheckConstraint(
        "workflow_versions_document_check",
        sql`octet_length(document) <= 262144`,
      )
      .execute();

    // Versions are immutable: the database refuses an update of a saved version, so no code path can change history. (Deleting is
    // not refused: the erasure of a workspace removes its rows.)
    await sql`create function workflow_versions_immutable() returns trigger as $$
      begin
        raise exception 'workflow versions are immutable' using errcode = 'restrict_violation';
      end;
      $$ language plpgsql`.execute(db);
    await sql`create trigger workflow_versions_no_update
      before update on workflow_versions
      for each row execute function workflow_versions_immutable()`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("workflow_versions").execute();
    await sql`drop function workflow_versions_immutable()`.execute(db);
    await db.schema.dropTable("workflows").execute();
  },
};
