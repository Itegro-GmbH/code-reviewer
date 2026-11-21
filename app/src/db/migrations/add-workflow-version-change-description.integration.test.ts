// SPDX-License-Identifier: LicenseRef-Proprietary

// #1107: the change description migration is expand only. It adds one nullable text column to `workflow_versions`; every version
// written before it reads null, a new version can carry a text, and the migration can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261120200000_add_workflow_version_change_description";
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

async function seedWorkflow(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T}) on conflict do nothing`.execute(
    db,
  );
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T}) on conflict do nothing`.execute(
    db,
  );
  await sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
    values ('wf-1', 'w-1', 'lane', 1, 'u-1', ${T}, ${T})`.execute(db);
  await sql`insert into workflow_versions (workflow_id, version, workspace_id, document, created_by, created_at)
    values ('wf-1', 1, 'w-1', '{}', 'u-1', ${T})`.execute(db);
}

describe("the workflow version change description migration", () => {
  // #1107-M01
  it("leaves every version written before it with no change description", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seedWorkflow(db);

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(
      await db.selectFrom("workflow_versions").selectAll().execute(),
    ).toEqual([
      expect.objectContaining({
        workflow_id: "wf-1",
        version: 1,
        change_description: null,
      }),
    ]);
    await db.destroy();
  });

  // #1107-M01
  it("stores the change description of a new version", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seedWorkflow(db);

    await db
      .insertInto("workflow_versions")
      .values({
        workflow_id: "wf-1",
        version: 2,
        workspace_id: "w-1",
        document: "{}",
        created_by: "u-1",
        created_at: T,
        change_description: "Raised the budget",
      })
      .execute();

    expect(
      await db
        .selectFrom("workflow_versions")
        .select(["version", "change_description"])
        .orderBy("version")
        .execute(),
    ).toEqual([
      { version: 1, change_description: null },
      { version: 2, change_description: "Raised the budget" },
    ]);
    await db.destroy();
  });

  // #1107-M01
  it("can be taken back", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    const columns = sql<{
      name: string;
    }>`select column_name as name from information_schema.columns
       where table_name = 'workflow_versions' and column_name = 'change_description'`;
    expect((await columns.execute(db)).rows).toHaveLength(1);

    const { migration } =
      await import("./20261120200000_add_workflow_version_change_description.ts");
    await migration.down?.(db);

    expect((await columns.execute(db)).rows).toHaveLength(0);
    await db.destroy();
  });
});
