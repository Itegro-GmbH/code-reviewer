// SPDX-License-Identifier: LicenseRef-Proprietary

// #916: the migration for workflows with several triggers is expand only. It adds the id of the trigger of the document that started a run
// (null for every run that exists), widens the kinds a run can have (the old name of the label trigger stays valid), keeps the rule that
// a run started by a person has a user, and can be run again and taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261107110000_add_workflow_run_trigger_id";
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
    kind?: string;
    createdBy?: string | null;
    triggerId?: string;
  } = {},
) => {
  const { kind = "manual", createdBy = "u-1", triggerId } = options;
  return sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input,
      status, budget_micro_usd, client_request_id, trigger_kind, trigger_id, created_by, actor_login, created_at, updated_at)
    values (${id}, 'w-1', 'wf-1', 1, 'r-1', 'main', '{}', 'running', 20000000, ${id}, ${kind}, ${triggerId ?? null}, ${createdBy}, 'octocat', ${T}, ${T})`;
};

describe("the workflow run trigger id migration", () => {
  // #916-T100
  it("changes no existing row: no run that exists has a trigger id, and the kinds they have stay", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    await sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input,
        status, budget_micro_usd, client_request_id, trigger_kind, created_by, actor_login, created_at, updated_at)
      values ('by-hand', 'w-1', 'wf-1', 1, 'r-1', 'main', '{}', 'running', 20000000, 'a', 'manual', 'u-1', 'octocat', ${T}, ${T}),
        ('by-label', 'w-1', 'wf-1', 1, 'r-1', 'main', '{}', 'running', 20000000, 'b', 'github.issueLabeled', null, 'octocat', ${T}, ${T})`.execute(
      db,
    );

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(
      (
        await sql<{
          id: string;
          trigger_kind: string;
          trigger_id: string | null;
        }>`select id, trigger_kind, trigger_id from workflow_runs order by id`.execute(
          db,
        )
      ).rows,
    ).toEqual([
      { id: "by-hand", trigger_kind: "manual", trigger_id: null },
      { id: "by-label", trigger_kind: "github.issueLabeled", trigger_id: null },
    ]);
    await db.destroy();
  });

  // #916-T101
  it("takes the new kinds and the id of a trigger, and still refuses a kind it does not know", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await run("a", {
      kind: "ticket.labeled",
      createdBy: null,
      triggerId: "labeled",
    }).execute(db);
    await run("b", { kind: "api", triggerId: "api" }).execute(db);
    await run("c", { kind: "manual", triggerId: "manual" }).execute(db);
    await run("d", { kind: "github.issueLabeled", createdBy: null }).execute(
      db,
    );
    await run("e", { kind: "pullRequest.pushed", createdBy: null }).execute(db);
    await run("f", { kind: "schedule", createdBy: null }).execute(db);
    await expect(run("g", { kind: "webhook" }).execute(db)).rejects.toThrow(
      /workflow_runs_trigger_check/,
    );
    await db.destroy();
  });

  // #916-T102
  it("keeps the rule that a run started by a person has a user, for the api trigger too", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await expect(
      run("a", { kind: "manual", createdBy: null }).execute(db),
    ).rejects.toThrow(/workflow_runs_trigger_check/);
    await expect(
      run("b", { kind: "api", createdBy: null }).execute(db),
    ).rejects.toThrow(/workflow_runs_trigger_check/);
    await db.destroy();
  });

  // #916-T103
  it("holds the id of a trigger to 64 characters", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await run("a", { triggerId: "t".repeat(64) }).execute(db);
    await expect(
      run("b", { triggerId: "t".repeat(65) }).execute(db),
    ).rejects.toThrow(/workflow_runs_trigger_id_check/);
    await expect(run("c", { triggerId: "" }).execute(db)).rejects.toThrow(
      /workflow_runs_trigger_id_check/,
    );
    await db.destroy();
  });

  // #916-T104
  it("can be run again and taken back while no run of a new kind exists", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    const { migration } =
      await import("./20261107110000_add_workflow_run_trigger_id.ts");
    await migration.up(db);
    await run("a", { kind: "manual", triggerId: "manual" }).execute(db);

    await migration.down?.(db);

    const { rows } = await sql<{
      column_name: string;
    }>`select column_name from information_schema.columns
      where table_name = 'workflow_runs' and column_name = 'trigger_id'`.execute(
      db,
    );
    expect(rows).toHaveLength(0);
    // The old check is back: the kinds of before only.
    await expect(
      sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input,
          status, budget_micro_usd, client_request_id, trigger_kind, created_by, actor_login, created_at, updated_at)
        values ('b', 'w-1', 'wf-1', 1, 'r-1', 'main', '{}', 'running', 20000000, 'b', 'api', 'u-1', 'octocat', ${T}, ${T})`.execute(
        db,
      ),
    ).rejects.toThrow(/workflow_runs_trigger_check/);
    await db.destroy();
  });
});
