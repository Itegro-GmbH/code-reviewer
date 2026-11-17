// SPDX-License-Identifier: LicenseRef-Proprietary

// #1036: the migration that lets a run be started by a move into a status (`trigger_kind` `ticket.statusChanged`) changes no row, keeps
// every other kind and the rule that only a run started by hand or through the API has a user, and can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261114150000_widen_workflow_run_trigger_for_status";
const T = "2026-11-14T08:00:00.000Z";

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

const run = (id: string, kind: string, createdBy: string | null) =>
  sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input, status, budget_micro_usd, client_request_id, trigger_kind, created_by, actor_login, created_at, updated_at)
    values (${id}, 'w-1', 'wf-1', 1, 'r-1', 'main', '{}', 'running', 1000000, ${`req-${id}`}, ${kind}, ${createdBy}, 'octocat', ${T}, ${T})`;

describe("the status trigger migration", () => {
  // #1036-T01
  it("keeps the runs written before it and refuses the kind before it, then takes it after", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    await run("run-1", "ticket.labeled", null).execute(db);
    await expect(
      run("run-2", "ticket.statusChanged", null).execute(db),
    ).rejects.toThrow();

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(
      await db
        .selectFrom("workflow_runs")
        .select(["id", "trigger_kind"])
        .execute(),
    ).toEqual([{ id: "run-1", trigger_kind: "ticket.labeled" }]);
    await run("run-3", "ticket.statusChanged", null).execute(db);
    await db.destroy();
  });

  it("keeps the other kinds and the rule that only a run started by a person needs a user", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await run("run-1", "manual", "u-1").execute(db);
    await run("run-2", "api", "u-1").execute(db);
    await run("run-3", "ticket.labeled", null).execute(db);
    await run("run-4", "github.issueLabeled", null).execute(db);
    await run("run-5", "ticket.statusChanged", null).execute(db);

    await expect(run("run-6", "manual", null).execute(db)).rejects.toThrow();
    await expect(run("run-7", "api", null).execute(db)).rejects.toThrow();
    await expect(run("run-8", "cron", null).execute(db)).rejects.toThrow();
    await db.destroy();
  });

  it("can be taken back once no run of the new kind is left", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    const { migration } =
      await import("./20261114150000_widen_workflow_run_trigger_for_status.ts");

    await migration.down?.(db);

    await expect(
      run("run-1", "ticket.statusChanged", null).execute(db),
    ).rejects.toThrow();
    await run("run-2", "ticket.labeled", null).execute(db);
    await db.destroy();
  });
});
