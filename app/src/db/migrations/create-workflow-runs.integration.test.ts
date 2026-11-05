// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: the workflow runs migration is expand only. It adds two empty tables to a database made by the previous release's migrations
// (the live one has jobs, implementer rows and workflows), changes no existing row and no existing table, and can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const THIS = "20261105130000_create_workflow_runs";
const T = "2026-11-05T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

async function snapshot(
  db: Kysely<Database>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (table.name === "workflow_runs" || table.name === "workflow_step_runs")
      continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)} order by 1`.execute(
        db,
      );
    result[table.name] = withoutColumnsAddedLater(table.name, rows);
  }
  return result;
}

async function columns(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{
    name: string;
  }>`select table_name || '.' || column_name as name from information_schema.columns
    where table_schema = 'public' and table_name not in ('workflow_runs', 'workflow_step_runs') order by 1`.execute(
    db,
  );
  return rows.map((row) => row.name);
}

async function seed(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
    db,
  );
  await sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
    values ('f-1', 'w-1', 'Flow', 1, 'u-1', ${T}, ${T})`.execute(db);
  await sql`insert into workflow_versions (workflow_id, version, workspace_id, document, created_by, created_at)
    values ('f-1', 1, 'w-1', '{}', 'u-1', ${T})`.execute(db);
}

/** A repository row, for the runs that point at one. */
async function seedRepository(db: Kysely<Database>) {
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
    values ('i-1', 'w-1', 'github_app', 'acme', 'ext-1', '{}', 'active', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
    values ('r-1', 'w-1', 'i-1', 'repo-1', 'acme/widgets', 'https://github.test/acme/widgets', 1, ${T}, ${T})`.execute(
    db,
  );
}

const run = (id: string, request: string) =>
  sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input,
      status, budget_micro_usd, client_request_id, created_by, actor_login, created_at, updated_at)
    values (${id}, 'w-1', 'f-1', 1, 'r-1', 'main', '{}', 'running', 20000000, ${request}, 'u-1', 'octocat', ${T}, ${T})`;

describe("the workflow runs migration", () => {
  // #844-T130
  it("adds two empty tables to an existing database and changes no existing row or column", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seed(db);
    const rows = await snapshot(db);
    const before = await columns(db);

    const { executed } = await migrateToLatest(db, migrationProvider);

    expect(executed).toContain(THIS);
    expect(await snapshot(db)).toEqual(rows);
    expect(await columns(db)).toEqual(before);
    const { rows: counts } = await sql<{
      runs: number;
      steps: number;
    }>`select (select count(*) from workflow_runs)::int as runs, (select count(*) from workflow_step_runs)::int as steps`.execute(
      db,
    );
    expect(counts).toEqual([{ runs: 0, steps: 0 }]);
    await db.destroy();
  });

  // #844-T131
  it("is applied once: running it again applies nothing", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    expect((await migrateToLatest(db, migrationProvider)).executed).toEqual([]);
    await db.destroy();
  });

  // #844-T132
  it("can be taken back, leaving the other tables as they were", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    const before = await columns(db);

    await (await migrationProvider.getMigrations())[THIS]?.down?.(db);

    const { rows } = await sql<{
      name: string;
    }>`select table_name as name from information_schema.tables
      where table_schema = 'public' and table_name like 'workflow\\_%runs'`.execute(
      db,
    );
    expect(rows).toEqual([]);
    expect(await columns(db)).toEqual(before);
    await db.destroy();
  });

  // #844-T133
  it("keeps one run per request id and workspace, the status and the money in range, and one step per place, id and job", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    await seedRepository(db);
    await run("run-1", "req-1").execute(db);

    await expect(run("run-2", "req-1").execute(db)).rejects.toThrow(
      /workflow_runs_request_unique/,
    );
    await expect(
      sql`update workflow_runs set status = 'paused', finished_at = ${T} where id = 'run-1'`.execute(
        db,
      ),
    ).rejects.toThrow(/workflow_runs_status_check/);
    await expect(
      sql`update workflow_runs set status = 'succeeded' where id = 'run-1'`.execute(
        db,
      ),
    ).rejects.toThrow(/workflow_runs_end_check/);
    await expect(
      sql`update workflow_runs set spent_micro_usd = -1 where id = 'run-1'`.execute(
        db,
      ),
    ).rejects.toThrow(/workflow_runs_money_check/);
    await expect(
      sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input,
        status, budget_micro_usd, client_request_id, created_by, actor_login, created_at, updated_at)
        values ('run-3', 'w-1', 'f-1', 2, 'r-1', 'main', '{}', 'running', 1, 'req-3', 'u-1', 'octocat', ${T}, ${T})`.execute(
        db,
      ),
    ).rejects.toThrow(/workflow_runs_version_fkey/);

    const step = (id: string, position: number, stepId: string) =>
      sql`insert into workflow_step_runs (id, run_id, workspace_id, position, step_id, kind, status, created_at)
        values (${id}, 'run-1', 'w-1', ${position}, ${stepId}, 'agent', 'pending', ${T})`;
    await step("s-1", 0, "plan").execute(db);
    await expect(step("s-2", 0, "other").execute(db)).rejects.toThrow(
      /workflow_step_runs_position_unique/,
    );
    await expect(step("s-3", 1, "plan").execute(db)).rejects.toThrow(
      /workflow_step_runs_step_unique/,
    );
    await expect(
      sql`update workflow_step_runs set status = 'succeeded' where id = 's-1'`.execute(
        db,
      ),
    ).rejects.toThrow(/workflow_step_runs_end_check/);
    await expect(
      sql`update workflow_step_runs set profile_name = 'worker' where id = 's-1'`.execute(
        db,
      ),
    ).rejects.toThrow(/workflow_step_runs_profile_check/);
    await db.destroy();
  });

  // #844-T134
  it("keeps the lock timeout it sets to itself: a later migration of the same batch does not inherit it", async () => {
    const { db } = await createEmptyTestDatabase({ poolMax: 1 });
    const seenByLaterMigration: string[] = [];
    const withProbe: MigrationProvider = {
      async getMigrations() {
        return {
          ...(await migrationProvider.getMigrations()),
          "99999999999999_probe_lock_timeout": {
            async up(trx) {
              const { rows } = await sql<{
                value: string;
              }>`select current_setting('lock_timeout') as value`.execute(trx);
              seenByLaterMigration.push(rows[0]?.value ?? "");
            },
          },
        };
      },
    };

    const { executed } = await migrateToLatest(db, withProbe);

    expect(
      executed.indexOf("99999999999999_probe_lock_timeout"),
    ).toBeGreaterThan(executed.indexOf(THIS));
    expect(seenByLaterMigration).toEqual(["0"]);
    await db.destroy();
  });
});
