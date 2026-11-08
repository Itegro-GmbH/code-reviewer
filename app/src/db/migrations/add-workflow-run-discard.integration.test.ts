// SPDX-License-Identifier: LicenseRef-Proprietary

// #921: the migration for the discarded run is expand only. A run may be `discarded` (it has an end time, and a failed run that is discarded
// keeps its error code), a run has the time it was discarded and the time a pause was asked for (null for every run that exists), a discarded
// run frees the one slot of its ticket, and the migration can be run again and taken back while no run is discarded.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261107200000_add_workflow_run_discard";
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
  options: {
    status?: string;
    key?: string | null;
    finished?: boolean;
    errorCode?: string | null;
  } = {},
) => {
  const {
    status = "running",
    key = null,
    finished = false,
    errorCode = null,
  } = options;
  return sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input,
      status, error_code, budget_micro_usd, client_request_id, trigger_kind, trigger_key, created_by, actor_login, created_at, updated_at, finished_at)
    values (${id}, 'w-1', 'wf-1', 1, 'r-1', 'main', '{}', ${status}, ${errorCode}, 20000000, ${id}, 'manual', ${key}, 'u-1', 'octocat', ${T}, ${T}, ${finished ? T : null})`;
};

describe("the workflow run discard migration", () => {
  // #921-T90
  it("changes no existing row: the runs that exist keep their status and have no discard time and no pause", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    await run("run-1").execute(db);
    await run("run-2", { status: "cancelled", finished: true }).execute(db);

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(
      (
        await sql<{
          id: string;
          status: string;
          discarded_at: string | null;
          pause_requested_at: string | null;
        }>`select id, status, discarded_at, pause_requested_at from workflow_runs order by id`.execute(
          db,
        )
      ).rows,
    ).toEqual([
      {
        id: "run-1",
        status: "running",
        discarded_at: null,
        pause_requested_at: null,
      },
      {
        id: "run-2",
        status: "cancelled",
        discarded_at: null,
        pause_requested_at: null,
      },
    ]);
    await db.destroy();
  });

  // #921-T91
  it("takes `discarded` for a run with an end time, keeps the code of a failed run that is discarded, and still refuses the rest", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await run("run-1", { status: "discarded", finished: true }).execute(db);
    await run("run-2", {
      status: "discarded",
      finished: true,
      errorCode: "step_failed",
    }).execute(db);
    // A discarded run is over: no end time says it still runs.
    await expect(
      run("run-3", { status: "discarded", finished: false }).execute(db),
    ).rejects.toThrow(/workflow_runs_end_check/);
    // A code belongs to a failure, kept when the failed run is discarded; nothing else carries one.
    await expect(
      run("run-4", {
        status: "succeeded",
        finished: true,
        errorCode: "step_failed",
      }).execute(db),
    ).rejects.toThrow(/workflow_runs_end_check/);
    await expect(
      run("run-5", { status: "paused", finished: true }).execute(db),
    ).rejects.toThrow(/workflow_runs_status_check/);
    // The stop of #891 stays readable.
    await run("run-6", { status: "cancelled", finished: true }).execute(db);
    await db.destroy();
  });

  // #921-T92
  it("frees the one slot of the ticket when the run is discarded", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await run("run-1", { status: "waiting", key: "r-1#7" }).execute(db);
    await expect(
      run("run-2", { status: "running", key: "r-1#7" }).execute(db),
    ).rejects.toThrow(/workflow_runs_trigger_active_unique/);
    await sql`update workflow_runs set status = 'discarded', discarded_at = ${T}, finished_at = ${T} where id = 'run-1'`.execute(
      db,
    );
    await run("run-3", { status: "running", key: "r-1#7" }).execute(db);
    await db.destroy();
  });

  // #921-T93
  it("can be run again and taken back while no run is discarded", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    const { migration } =
      await import("./20261107200000_add_workflow_run_discard.ts");
    await migration.up(db);
    await run("run-1", { key: "r-1#7" }).execute(db);

    await migration.down?.(db);

    const { rows } = await sql<{
      column_name: string;
    }>`select column_name from information_schema.columns
      where table_name = 'workflow_runs' and column_name in ('discarded_at', 'pause_requested_at')`.execute(
      db,
    );
    expect(rows).toHaveLength(0);
    await expect(
      run("run-2", { status: "discarded", finished: true }).execute(db),
    ).rejects.toThrow(/workflow_runs_status_check/);
    await db.destroy();
  });
});
