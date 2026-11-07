// SPDX-License-Identifier: LicenseRef-Proprietary

// #920: the migration for the run that waits for an answer is expand only. A run and a step may be `waiting` (a waiting run has no end time),
// a step has the question it asked and the comment that carries it (null for every step that exists), the one-run-per-ticket index counts a
// waiting run, and it can be run again and taken back while nothing waits.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261107170000_add_workflow_run_waiting";
const T = "2026-11-07T08:00:00.000Z";

function upTo(include: (name: string) => boolean): MigrationProvider {
  return {
    async getMigrations() {
      return Object.fromEntries(
        Object.entries(await migrationProvider.getMigrations()).filter(
          ([name]) => include(name),
        ),
      );
    },
  };
}

async function seed(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
    db,
  );
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
    values ('i-1', 'w-1', 'github_app', 'acme', 'ext-1', '{}', 'active', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
    values ('r-1', 'w-1', 'i-1', 'repo-1', 'acme/widgets', 'https://github.test/acme/widgets', 1, ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
    values ('wf-1', 'w-1', 'Flow', 1, 'u-1', ${T}, ${T})`.execute(db);
  await sql`insert into workflow_versions (workflow_id, version, workspace_id, document, created_by, created_at)
    values ('wf-1', 1, 'w-1', '{}', 'u-1', ${T})`.execute(db);
}

const run = (
  id: string,
  options: { status?: string; key?: string | null; finished?: boolean } = {},
) => {
  const { status = "running", key = null, finished = false } = options;
  return sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input,
      status, budget_micro_usd, client_request_id, trigger_kind, trigger_key, created_by, actor_login, created_at, updated_at, finished_at)
    values (${id}, 'w-1', 'wf-1', 1, 'r-1', 'main', '{}', ${status}, 20000000, ${id}, 'manual', ${key}, 'u-1', 'octocat', ${T}, ${T}, ${finished ? T : null})`;
};

const step = (
  id: string,
  options: {
    status?: string;
    ask?: string | null;
    comment?: string | null;
  } = {},
) => {
  const { status = "running", ask = null, comment = null } = options;
  return sql`insert into workflow_step_runs (id, run_id, workspace_id, position, step_id, kind, status, ask, waiting_on_comment_id, created_at)
    values (${id}, 'run-1', 'w-1', 0, ${id}, 'agent', ${status}, ${ask}, ${comment}, ${T})`;
};

describe("the workflow run waiting migration", () => {
  // #920-T70
  it("changes no existing row: the runs and steps that exist keep their status and have no question", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    await run("run-1").execute(db);
    await sql`insert into workflow_step_runs (id, run_id, workspace_id, position, step_id, kind, status, created_at)
      values ('plan', 'run-1', 'w-1', 0, 'plan', 'agent', 'running', ${T})`.execute(
      db,
    );

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(
      (
        await sql<{
          status: string;
          ask: string | null;
          waiting_on_comment_id: string | null;
        }>`select status, ask, waiting_on_comment_id from workflow_step_runs`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ status: "running", ask: null, waiting_on_comment_id: null }]);
    expect(
      (
        await sql<{ status: string }>`select status from workflow_runs`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ status: "running" }]);
    await db.destroy();
  });

  // #920-T71
  it("takes `waiting` for a run without an end time and for a step with a question, and still refuses the rest", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await run("run-1", { status: "waiting" }).execute(db);
    await step("plan", {
      status: "waiting",
      ask: '{"question":"q"}',
      comment: "9001",
    }).execute(db);
    // A waiting run is not over: an end time would say it is.
    await expect(
      run("run-2", { status: "waiting", finished: true }).execute(db),
    ).rejects.toThrow(/workflow_runs_end_check/);
    await expect(
      run("run-3", { status: "paused" }).execute(db),
    ).rejects.toThrow(/workflow_runs_status_check/);
    await expect(
      sql`update workflow_step_runs set status = 'paused' where id = 'plan'`.execute(
        db,
      ),
    ).rejects.toThrow(/workflow_step_runs_status_check/);
    await db.destroy();
  });

  // #920-T72
  it("holds a waiting step to its question and the sizes of the columns", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    await run("run-1", { status: "waiting" }).execute(db);

    await expect(step("a", { status: "waiting" }).execute(db)).rejects.toThrow(
      /workflow_step_runs_ask_check/,
    );
    await expect(
      step("b", { ask: "x".repeat(32769) }).execute(db),
    ).rejects.toThrow(/workflow_step_runs_ask_check/);
    await expect(
      step("c", { comment: "1".repeat(65) }).execute(db),
    ).rejects.toThrow(/workflow_step_runs_ask_check/);
    await step("d", { ask: "x".repeat(32768) }).execute(db);
    await db.destroy();
  });

  // #920-T73
  it("lets a waiting run hold the one slot of its ticket: a second run for the key is refused while it waits or runs, and allowed once it ended", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await run("run-1", { status: "waiting", key: "r-1#7" }).execute(db);
    await expect(
      run("run-2", { status: "running", key: "r-1#7" }).execute(db),
    ).rejects.toThrow(/workflow_runs_trigger_active_unique/);
    await run("run-3", { status: "running", key: "r-1#8" }).execute(db);
    await expect(
      run("run-4", { status: "waiting", key: "r-1#8" }).execute(db),
    ).rejects.toThrow(/workflow_runs_trigger_active_unique/);
    await sql`update workflow_runs set status = 'cancelled', finished_at = ${T} where id = 'run-1'`.execute(
      db,
    );
    await run("run-5", { status: "running", key: "r-1#7" }).execute(db);
    expect(
      (
        await sql`select 1 from pg_indexes where indexname = 'workflow_runs_trigger_running_unique'`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(0);
    await db.destroy();
  });

  // #920-T74
  it("can be run again and taken back while nothing waits", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    const { migration } =
      await import("./20261107170000_add_workflow_run_waiting.ts");
    await migration.up(db);
    await run("run-1", { key: "r-1#7" }).execute(db);

    await migration.down?.(db);

    const { rows } = await sql<{
      column_name: string;
    }>`select column_name from information_schema.columns
      where table_name = 'workflow_step_runs' and column_name in ('ask', 'waiting_on_comment_id')`.execute(
      db,
    );
    expect(rows).toHaveLength(0);
    await expect(
      run("run-2", { status: "waiting" }).execute(db),
    ).rejects.toThrow(/workflow_runs_status_check/);
    await expect(
      run("run-3", { status: "running", key: "r-1#7" }).execute(db),
    ).rejects.toThrow(/workflow_runs_trigger_running_unique/);
    await db.destroy();
  });
});
