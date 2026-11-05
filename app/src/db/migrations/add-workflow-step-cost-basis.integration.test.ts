// SPDX-License-Identifier: LicenseRef-Proprietary

// #873: the cost basis migration is expand only. It adds one nullable column, every step written before reads null, a basis needs a
// cost and must be one of the three known ones, and the migration can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261105150000_add_workflow_step_cost_basis";
const T = "2026-11-05T08:00:00.000Z";

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
  await sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input, status, budget_micro_usd, client_request_id, created_by, actor_login, created_at, updated_at)
    values ('run-1', 'w-1', 'wf-1', 1, 'r-1', 'main', '{}', 'running', 1000000, 'req-1', 'u-1', 'octocat', ${T}, ${T})`.execute(
    db,
  );
}

const step = (id: string, basis: string | null, cost: number | null) =>
  sql`insert into workflow_step_runs (id, run_id, workspace_id, position, step_id, kind, status, cost_micro_usd, cost_basis, created_at)
    values (${id}, 'run-1', 'w-1', ${Number(id.slice(-1))}, ${id}, 'agent', 'pending', ${cost}, ${basis}, ${T})`;

describe("the workflow step cost basis migration", () => {
  // #873-T01
  it("leaves every step written before it with no basis", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    await sql`insert into workflow_step_runs (id, run_id, workspace_id, position, step_id, kind, status, cost_micro_usd, created_at)
      values ('s-0', 'run-1', 'w-1', 0, 'plan', 'agent', 'pending', 250000, ${T})`.execute(
      db,
    );

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(
      await db.selectFrom("workflow_step_runs").selectAll().execute(),
    ).toEqual([
      expect.objectContaining({
        id: "s-0",
        cost_micro_usd: 250000,
        cost_basis: null,
      }),
    ]);
    await db.destroy();
  });

  // #873-T02
  it("takes the three bases with a cost, and refuses another one or a basis without a cost", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await step("s-1", "reported", 10).execute(db);
    await step("s-2", "estimated", 10).execute(db);
    await step("s-3", "limit", 10).execute(db);
    await step("s-4", null, null).execute(db);

    await expect(step("s-5", "guessed", 10).execute(db)).rejects.toThrow();
    await expect(step("s-6", "reported", null).execute(db)).rejects.toThrow();
    await db.destroy();
  });

  // #873-T03
  it("can be taken back", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    const { rows: before } = await sql<{
      name: string;
    }>`select column_name as name from information_schema.columns
       where table_name = 'workflow_step_runs' and column_name = 'cost_basis'`.execute(
      db,
    );
    expect(before).toHaveLength(1);

    const { migration } =
      await import("./20261105150000_add_workflow_step_cost_basis.ts");
    await migration.down?.(db);

    const { rows: after } = await sql<{
      name: string;
    }>`select column_name as name from information_schema.columns
       where table_name = 'workflow_step_runs' and column_name = 'cost_basis'`.execute(
      db,
    );
    expect(after).toHaveLength(0);
    await db.destroy();
  });
});
