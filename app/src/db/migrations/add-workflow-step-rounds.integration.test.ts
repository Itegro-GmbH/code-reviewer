// SPDX-License-Identifier: LicenseRef-Proprietary

// #846: the migration that gives a workflow step a round, the kinds `if` and `loop` and the status `skipped`. Steps written before it keep
// their meaning (round 1), a step may run again in another round and not twice in the same one, and it can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261106090000_add_workflow_step_rounds";
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
  await sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
    values ('wf-1', 'w-1', 'Flow', 1, 'u-1', ${T}, ${T})`.execute(db);
  await sql`insert into workflow_versions (workflow_id, version, workspace_id, document, created_by, created_at)
    values ('wf-1', 1, 'w-1', '{}', 'u-1', ${T})`.execute(db);
  await sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input, status, budget_micro_usd, client_request_id, created_by, actor_login, created_at, updated_at)
    values ('run-1', 'w-1', 'wf-1', 1, 'r-1', 'main', '{}', 'running', 1000000, 'req-1', 'u-1', 'octocat', ${T}, ${T})`.execute(
    db,
  );
}

/** A step of run-1 that is over: the status and the kind are the test's. */
const step = (
  position: number,
  stepId: string,
  round: number,
  kind = "action",
  status = "succeeded",
) =>
  sql`insert into workflow_step_runs (id, run_id, workspace_id, position, step_id, kind, status, round, created_at, finished_at)
    values (${`s-${String(position)}`}, 'run-1', 'w-1', ${position}, ${stepId}, ${kind}, ${status}, ${round}, ${T}, ${T})`;

describe("the workflow step rounds migration", () => {
  // #846-T01
  it("gives every step written before it round 1", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    await sql`insert into workflow_step_runs (id, run_id, workspace_id, position, step_id, kind, status, created_at)
      values ('s-0', 'run-1', 'w-1', 0, 'plan', 'agent', 'pending', ${T})`.execute(
      db,
    );

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(
      await db.selectFrom("workflow_step_runs").selectAll().execute(),
    ).toEqual([expect.objectContaining({ id: "s-0", round: 1 })]);
    await db.destroy();
  });

  // #846-T02
  it("lets a step run again in another round, and refuses the same step twice in one round", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await step(0, "implement", 1).execute(db);
    await step(1, "implement", 2).execute(db);
    await step(2, "review", 1).execute(db);

    await expect(step(3, "implement", 2).execute(db)).rejects.toThrow();
    await expect(step(3, "review", 0).execute(db)).rejects.toThrow();
    await db.destroy();
  });

  // #846-T03
  it("takes the control kinds and the skipped status, and holds a skipped step to be over", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await step(0, "fix", 1, "loop").execute(db);
    await step(1, "done", 1, "if").execute(db);
    await step(2, "stuck", 1, "action", "skipped").execute(db);

    await expect(step(3, "x", 1, "forEach").execute(db)).rejects.toThrow();
    await expect(
      sql`insert into workflow_step_runs (id, run_id, workspace_id, position, step_id, kind, status, created_at)
        values ('s-9', 'run-1', 'w-1', 9, 'late', 'action', 'skipped', ${T})`.execute(
        db,
      ),
    ).rejects.toThrow();
    await db.destroy();
  });

  // #846-T04
  it("can be taken back", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const { migration } =
      await import("./20261106090000_add_workflow_step_rounds.ts");
    await migration.down?.(db);

    const { rows } = await sql<{
      name: string;
    }>`select column_name as name from information_schema.columns
       where table_name = 'workflow_step_runs' and column_name = 'round'`.execute(
      db,
    );
    expect(rows).toHaveLength(0);
    await seed(db);
    const old = (position: number, kind: string) =>
      sql`insert into workflow_step_runs (id, run_id, workspace_id, position, step_id, kind, status, created_at)
        values (${`s-${String(position)}`}, 'run-1', 'w-1', ${position}, 'plan', ${kind}, 'pending', ${T})`;
    await old(0, "agent").execute(db);
    await expect(old(1, "agent").execute(db)).rejects.toThrow();
    await expect(old(2, "loop").execute(db)).rejects.toThrow();
    await db.destroy();
  });
});
