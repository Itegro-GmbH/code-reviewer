// SPDX-License-Identifier: LicenseRef-Proprietary

// The runs of a workflow (#844, agent workflows, milestone 3): `workflow_runs` is one start of a saved workflow version, with the
// input of its trigger, its budget and what it has spent; `workflow_step_runs` is one step of it, in the order the steps run, with
// the Implementer turn (and its job) an agent step started, the result the step yielded and why it failed. The run names the
// workflow version it started with, so a later save changes nothing under it. Both tables are new and empty; nothing else points at
// them.
//
// Expand only, safe for the version that is still running (it never reads the tables) and for the live database:
//  - two tables are added; no column, row or index of an existing table changes;
//  - the tables have foreign keys to `workspaces`, `users`, `repositories`, `workflow_versions`, `jobs` and `implementer_turns`,
//    which take a short lock on those tables. The wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is
//    rolled back (`MIGRATION_FAILED`) and the deployment can simply be run again. A writer that waited behind a long lock request
//    would be worse than a failed deployment.
//  - `workflow_step_runs.workspace_id` repeats the workspace of the run, so every query of a step can filter by the workspace itself
//    (docs: workspace scoping) and the erasure of a workspace needs no join.
//  - Money is counted in millionths of a US dollar, as the usage records count it, in `integer` columns: the operator's maximum for
//    a workflow is 100 USD (1e8), far below the 2.1e9 an integer holds.
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
      .createTable("workflow_runs")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("workflow_id", "text", (column) => column.notNull())
      // The version the run started with: the document of that version is the run's, whatever is saved afterwards.
      .addColumn("workflow_version", "integer", (column) => column.notNull())
      // The repository the run works on (the one of its trigger) and the branch its agent steps start from.
      .addColumn("repository_id", "text", (column) =>
        column.notNull().references("repositories.id"),
      )
      .addColumn("base_branch", "text", (column) => column.notNull())
      // The input of the trigger as JSON text: what the caller of a manual trigger handed in.
      .addColumn("trigger_input", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      // Why a failed run failed (a stable code of `src/workflow-runs/errors.ts`); null while it runs and when it succeeded.
      .addColumn("error_code", "text")
      .addColumn("budget_micro_usd", "integer", (column) => column.notNull())
      .addColumn("spent_micro_usd", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      // Makes the start idempotent: one run per request id and workspace.
      .addColumn("client_request_id", "text", (column) => column.notNull())
      .addColumn("created_by", "text", (column) =>
        column.notNull().references("users.id"),
      )
      // The login the agent steps are started as (the person who started the run), kept because the steps start without a request.
      .addColumn("actor_login", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      // ISO 8601 UTC, set when the run ends.
      .addColumn("finished_at", "text")
      .addForeignKeyConstraint(
        "workflow_runs_version_fkey",
        ["workflow_id", "workflow_version"],
        "workflow_versions",
        ["workflow_id", "version"],
      )
      .addCheckConstraint(
        "workflow_runs_status_check",
        sql`status in ('running', 'succeeded', 'failed')`,
      )
      .addCheckConstraint(
        "workflow_runs_end_check",
        sql`(status = 'running') = (finished_at is null)
          and (status = 'failed' or error_code is null)`,
      )
      .addCheckConstraint(
        "workflow_runs_money_check",
        sql`budget_micro_usd > 0 and spent_micro_usd >= 0`,
      )
      .addCheckConstraint(
        "workflow_runs_input_check",
        sql`char_length(trigger_input) <= 65536
          and char_length(client_request_id) between 1 and 200
          and char_length(base_branch) between 1 and 255`,
      )
      .execute();

    await sql`create unique index workflow_runs_request_unique
      on workflow_runs (workspace_id, client_request_id)`.execute(db);
    await sql`create index workflow_runs_workflow_index
      on workflow_runs (workspace_id, workflow_id, created_at desc, id)`.execute(
      db,
    );
    // The runs that still run: what a sweep looks at.
    await sql`create index workflow_runs_running_index
      on workflow_runs (updated_at) where status = 'running'`.execute(db);

    await db.schema
      .createTable("workflow_step_runs")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("run_id", "text", (column) =>
        column.notNull().references("workflow_runs.id"),
      )
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      // The place in the list of steps, from 0; the steps of a run are linear in version 1 of the engine.
      .addColumn("position", "integer", (column) => column.notNull())
      .addColumn("step_id", "text", (column) => column.notNull())
      .addColumn("kind", "text", (column) => column.notNull())
      // `pending`: written, nothing done yet. `running`: claimed; an agent step has its job once the turn is queued.
      .addColumn("status", "text", (column) => column.notNull())
      // The profile version an agent step runs with, resolved when the step is written (an unpinned reference means the newest then).
      .addColumn("profile_name", "text")
      .addColumn("profile_version", "integer")
      .addColumn("job_id", "text", (column) => column.references("jobs.id"))
      .addColumn("turn_id", "text", (column) =>
        column.references("implementer_turns.id"),
      )
      // What the step may spend, and what it did spend (unknown costs are charged at the cap).
      .addColumn("cap_micro_usd", "integer")
      .addColumn("cost_micro_usd", "integer")
      // JSON text: the values later steps can refer to (the checked result of the agent and the facts of the turn, or the output of the action).
      .addColumn("output", "text")
      .addColumn("error_code", "text")
      .addColumn("error_message", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("started_at", "text")
      .addColumn("finished_at", "text")
      .addCheckConstraint(
        "workflow_step_runs_kind_check",
        sql`kind in ('agent', 'action')`,
      )
      .addCheckConstraint(
        "workflow_step_runs_status_check",
        sql`status in ('pending', 'running', 'succeeded', 'failed')`,
      )
      .addCheckConstraint(
        "workflow_step_runs_position_check",
        sql`position >= 0`,
      )
      .addCheckConstraint(
        "workflow_step_runs_profile_check",
        sql`(profile_name is null) = (profile_version is null)`,
      )
      .addCheckConstraint(
        "workflow_step_runs_end_check",
        sql`(status in ('succeeded', 'failed')) = (finished_at is not null)
          and (status = 'failed' or error_code is null)`,
      )
      .addCheckConstraint(
        "workflow_step_runs_size_check",
        sql`(output is null or char_length(output) <= 1048576)
          and (error_message is null or char_length(error_message) <= 2000)`,
      )
      .execute();

    await sql`create unique index workflow_step_runs_position_unique
      on workflow_step_runs (run_id, position)`.execute(db);
    await sql`create unique index workflow_step_runs_step_unique
      on workflow_step_runs (run_id, step_id)`.execute(db);
    // One step per job: the job-ended event finds the step by it.
    await sql`create unique index workflow_step_runs_job_unique
      on workflow_step_runs (job_id) where job_id is not null`.execute(db);
    await sql`create index workflow_step_runs_running_index
      on workflow_step_runs (created_at) where status in ('pending', 'running')`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("workflow_step_runs").execute();
    await db.schema.dropTable("workflow_runs").execute();
  },
};
