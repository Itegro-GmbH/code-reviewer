// SPDX-License-Identifier: LicenseRef-Proprietary

// The profiles of a workspace (#843, agent workflows, milestone 2): a profile is data a member writes and changes, never a built-in:
// the model, the instructions, the cost limit and the push right a turn runs with, and a default result schema. Every save is a new
// version that is never changed (the database refuses an UPDATE; only the erasure of a workspace deletes); `profiles` holds the
// name and which version is the current one, `profile_versions` holds what each version says. A profile is never deleted by the
// user: it is archived (`archived_at`), which hides it from the list, gives its name back and counts it no more against the
// workspace's maximum; its versions stay, because a turn may have run with one. The name never changes after the profile is made
// (a workflow refers to a profile by name and version).
//
// The turn copies the version it runs with (`implementer_turns.profile_*`, next migration), so nothing points into these tables.
//
// Expand only, safe for the version that is still running (it never reads the tables) and for the live database:
//  - two tables are added; no column, row or index of an existing table changes;
//  - the tables have foreign keys to `workspaces` and (`profiles`) `users`, which take a short lock on those tables. The wait is
//    bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and the deployment can
//    simply be run again;
//  - a composite foreign key (`profile_id`, `workspace_id`) to `profiles` makes the database itself refuse a version in another
//    workspace than its profile's, so a bug cannot link them across workspaces;
//  - `profile_versions.workspace_id` repeats the workspace of the profile, so every query of a version can filter by the workspace
//    itself (docs: workspace scoping) and the erasure of a workspace needs no join.
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
      .createTable("profiles")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      // The name a workflow writes in a step. Lower case, as the format has it; fixed for the life of the profile.
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("current_version", "integer", (column) => column.notNull())
      .addColumn("created_by", "text", (column) =>
        column.notNull().references("users.id"),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      // ISO 8601 UTC, set when the profile is archived.
      .addColumn("archived_at", "text")
      .addCheckConstraint(
        "profiles_name_check",
        sql`name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`,
      )
      .addCheckConstraint(
        "profiles_current_version_check",
        sql`current_version >= 1`,
      )
      .execute();

    // One name once per workspace among the profiles that are not archived.
    await sql`create unique index profiles_workspace_name_unique
      on profiles (workspace_id, name) where archived_at is null`.execute(db);

    // What the composite foreign key of the versions refers to (the id alone is the primary key already).
    await sql`create unique index profiles_id_workspace_unique
      on profiles (id, workspace_id)`.execute(db);

    await db.schema
      .createTable("profile_versions")
      .addColumn("profile_id", "text", (column) => column.notNull())
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("description", "text", (column) => column.notNull())
      // JSON text of exactly one of two shapes, as `implementer_turns.model_choice` holds it (src/db/implementer-model-choice.ts).
      .addColumn("model_choice", "text", (column) => column.notNull())
      // The system-level text the agent is given; empty for none.
      .addColumn("instructions", "text", (column) => column.notNull())
      // Whole US cents per turn; null: the operator's maximum alone.
      .addColumn("cost_limit_cents", "integer")
      // 1 when a turn of this version may push, 0 when not (the app's columns hold no booleans).
      .addColumn("can_push", "integer", (column) => column.notNull())
      // The JSON text of the result schema as it was validated, or null for none.
      .addColumn("default_result", "text")
      // Who saved this version, as the user id it had then. No foreign key: a version is history the database refuses to change, and
      // merging the instance admin with an imported operator retires the operator's user row (src/github-signin/merge.ts), which a
      // foreign key would forbid and the immutable row cannot be re-pointed away from.
      .addColumn("created_by", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("profile_versions_pkey", [
        "profile_id",
        "version",
      ])
      .addForeignKeyConstraint(
        "profile_versions_profile_fk",
        ["profile_id", "workspace_id"],
        "profiles",
        ["id", "workspace_id"],
      )
      .addCheckConstraint("profile_versions_version_check", sql`version >= 1`)
      .addCheckConstraint(
        "profile_versions_can_push_check",
        sql`can_push in (0, 1)`,
      )
      .addCheckConstraint(
        "profile_versions_description_check",
        sql`char_length(description) <= 1000`,
      )
      .addCheckConstraint(
        "profile_versions_instructions_check",
        sql`char_length(instructions) <= 20000`,
      )
      .addCheckConstraint(
        "profile_versions_cost_limit_check",
        sql`cost_limit_cents is null or cost_limit_cents between 1 and 10000`,
      )
      .addCheckConstraint(
        "profile_versions_default_result_check",
        sql`default_result is null or octet_length(default_result) <= 262144`,
      )
      .execute();

    // Versions are immutable: the database refuses an update of a saved version, so no code path can change history. (Deleting is
    // not refused: the erasure of a workspace removes its rows.)
    await sql`create function profile_versions_immutable() returns trigger as $$
      begin
        raise exception 'profile versions are immutable' using errcode = 'restrict_violation';
      end;
      $$ language plpgsql`.execute(db);
    await sql`create trigger profile_versions_no_update
      before update on profile_versions
      for each row execute function profile_versions_immutable()`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("profile_versions").execute();
    await sql`drop function profile_versions_immutable()`.execute(db);
    await db.schema.dropTable("profiles").execute();
  },
};
