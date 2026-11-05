// SPDX-License-Identifier: LicenseRef-Proprietary

// #845: the migration that lets a run of a label have no person is expand only. It changes no row that exists (every run so far was started
// by hand and keeps its user), adds one column with a default, refuses a run by hand without a user, and can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261105190000_add_workflow_run_trigger";
const T = "2026-11-05T08:00:00.000Z";

const upTo = (last: string): MigrationProvider => ({
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name <= last,
      ),
    );
  },
});

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

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
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
    values ('i-1', 'w-1', 'github_app', 'acme', 'ext-1', '{}', 'active', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
    values ('r-1', 'w-1', 'i-1', 'repo-1', 'acme/widgets', 'https://github.test/acme/widgets', 1, ${T}, ${T})`.execute(
    db,
  );
}

const run = (id: string, createdBy: string | null, kind?: string) =>
  kind === undefined
    ? sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input,
        status, budget_micro_usd, client_request_id, created_by, actor_login, created_at, updated_at)
      values (${id}, 'w-1', 'f-1', 1, 'r-1', 'main', '{}', 'running', 20000000, ${id}, ${createdBy}, 'octocat', ${T}, ${T})`
    : sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input,
        status, budget_micro_usd, client_request_id, trigger_kind, created_by, actor_login, created_at, updated_at)
      values (${id}, 'w-1', 'f-1', 1, 'r-1', 'main', '{}', 'running', 20000000, ${id}, ${kind}, ${createdBy}, 'octocat', ${T}, ${T})`;

describe("the workflow run trigger migration", () => {
  // #845-T50
  it("keeps a run that exists as a run started by hand, with its user", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seed(db);
    await run("run-old", "u-1").execute(db);

    const { executed } = await migrateToLatest(db, upTo(THIS));

    expect(executed).toContain(THIS);
    const { rows } = await sql<{
      trigger_kind: string;
      created_by: string | null;
      actor_login: string;
    }>`select trigger_kind, created_by, actor_login from workflow_runs where id = 'run-old'`.execute(
      db,
    );
    expect(rows).toEqual([
      { trigger_kind: "manual", created_by: "u-1", actor_login: "octocat" },
    ]);
    await db.destroy();
  });

  // #845-T51
  it("lets a run of a label have no user, and nothing else: a run by hand still needs one", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await run("run-label", null, "github.issueLabeled").execute(db);
    await expect(run("run-nobody", null).execute(db)).rejects.toThrow(
      /workflow_runs_trigger_check/,
    );
    await expect(run("run-nobody", null, "manual").execute(db)).rejects.toThrow(
      /workflow_runs_trigger_check/,
    );
    await expect(
      run("run-unknown", "u-1", "schedule").execute(db),
    ).rejects.toThrow(/workflow_runs_trigger_check/);
    await db.destroy();
  });

  // #845-T52
  it("is applied once and can be taken back while no run of a label exists", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    expect((await migrateToLatest(db, migrationProvider)).executed).toEqual([]);
    await seed(db);
    await run("run-1", "u-1").execute(db);

    await (await migrationProvider.getMigrations())[THIS]?.down?.(db);

    const { rows } = await sql<{
      name: string;
      nullable: string;
    }>`select column_name as name, is_nullable as nullable from information_schema.columns
      where table_name = 'workflow_runs' and column_name in ('trigger_kind', 'created_by')`.execute(
      db,
    );
    expect(rows).toEqual([{ name: "created_by", nullable: "NO" }]);
    await db.destroy();
  });
});
