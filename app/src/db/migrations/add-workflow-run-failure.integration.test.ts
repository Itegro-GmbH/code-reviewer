// SPDX-License-Identifier: LicenseRef-Proprietary

// #902: the migration that keeps how a failing run ends while its `onFailure` steps run: one nullable column with a size check. Rows written
// before it keep their meaning (no failure), an oversized value is refused, and it can be run again and taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261106004000_add_workflow_run_failure";
const T = "2026-11-06T08:00:00.000Z";

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
  await sql`insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args, trigger_kind, actor_login,
      status, run_after, attempts, created_at, updated_at)
    values ('j-1', 'w-1', 'r-1', -1, 'https://github.test/acme/widgets/tree/b', ${"a".repeat(40)}, 'review', '', 'manual', 'octocat',
      'queued', ${T}, 0, ${T}, ${T})`.execute(db);
  await sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
    values ('wf-1', 'w-1', 'Flow', 1, 'u-1', ${T}, ${T})`.execute(db);
  await sql`insert into workflow_versions (workflow_id, version, workspace_id, document, created_by, created_at)
    values ('wf-1', 1, 'w-1', '{}', 'u-1', ${T})`.execute(db);
  await sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input, status, budget_micro_usd, client_request_id, created_by, actor_login, created_at, updated_at)
    values ('run-1', 'w-1', 'wf-1', 1, 'r-1', 'main', '{}', 'running', 1000000, 'req-1', 'u-1', 'octocat', ${T}, ${T})`.execute(
    db,
  );
}

describe("the workflow run failure migration", () => {
  // #902-T80
  it("changes no existing row: no run that exists is failing", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(await db.selectFrom("workflow_runs").selectAll().execute()).toEqual([
      expect.objectContaining({
        id: "run-1",
        status: "running",
        failure: null,
      }),
    ]);
    await db.destroy();
  });

  // #902-T81
  it("stores the failure as text and refuses one that is too long", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await sql`update workflow_runs set failure = ${'{"status":"failed"}'} where id = 'run-1'`.execute(
      db,
    );
    await expect(
      sql`update workflow_runs set failure = ${"x".repeat(4097)} where id = 'run-1'`.execute(
        db,
      ),
    ).rejects.toThrow();

    expect(
      await db.selectFrom("workflow_runs").select("failure").execute(),
    ).toEqual([{ failure: '{"status":"failed"}' }]);
    await db.destroy();
  });

  // #902-T82
  it("can be run again and taken back", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const { migration } =
      await import("./20261106004000_add_workflow_run_failure.ts");
    await migration.up(db);
    await migration.down?.(db);

    const { rows } = await sql<{
      column_name: string;
    }>`select column_name from information_schema.columns
       where table_name = 'workflow_runs' and column_name = 'failure'`.execute(
      db,
    );
    expect(rows).toHaveLength(0);
    await db.destroy();
  });
});
