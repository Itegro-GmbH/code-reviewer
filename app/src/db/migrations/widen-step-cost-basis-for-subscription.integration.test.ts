// SPDX-License-Identifier: LicenseRef-Proprietary

// #856: the migration that lets a step's cost basis be `subscription` (an estimate of a turn that is not billed) changes no row, keeps
// every other basis and its rules (a basis needs a cost, an unknown word is refused), and can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261105231000_widen_step_cost_basis_for_subscription";
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

describe("the subscription cost basis migration", () => {
  // #856-T42
  it("keeps the steps written before it and refuses the basis before it, then takes it after", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    await step("s-1", "limit", 10).execute(db);
    await expect(step("s-2", "subscription", 10).execute(db)).rejects.toThrow();

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(
      await db
        .selectFrom("workflow_step_runs")
        .select(["id", "cost_basis"])
        .execute(),
    ).toEqual([{ id: "s-1", cost_basis: "limit" }]);
    await step("s-3", "subscription", 0).execute(db);
    await db.destroy();
  });

  // #856-T42
  it("keeps the rules of the other bases", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await step("s-1", "reported", 10).execute(db);
    await step("s-2", "estimated", 10).execute(db);
    await step("s-3", "limit", 10).execute(db);
    await step("s-4", "subscription", 10).execute(db);
    await step("s-5", null, null).execute(db);

    await expect(step("s-6", "guessed", 10).execute(db)).rejects.toThrow();
    await expect(
      step("s-7", "subscription", null).execute(db),
    ).rejects.toThrow();
    await db.destroy();
  });

  // #856-T42
  it("can be taken back, and a subscription step reads as an estimate then", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    await step("s-1", "subscription", 10).execute(db);

    const { migration } =
      await import("./20261105231000_widen_step_cost_basis_for_subscription.ts");
    await migration.down?.(db);

    expect(
      await db
        .selectFrom("workflow_step_runs")
        .select(["id", "cost_basis"])
        .execute(),
    ).toEqual([{ id: "s-1", cost_basis: "estimated" }]);
    await expect(step("s-2", "subscription", 10).execute(db)).rejects.toThrow();
    await db.destroy();
  });
});
