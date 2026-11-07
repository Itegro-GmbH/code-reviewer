// SPDX-License-Identifier: LicenseRef-Proprietary

// #919: the profile environment migration is expand only. It adds one nullable text column to the profile versions, every version
// written before it reads null, and it can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261107180000_add_profile_environment";
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
  await sql`insert into profiles (id, workspace_id, name, current_version, created_by, created_at, updated_at)
    values ('p-1', 'w-1', 'writer', 1, 'u-1', ${T}, ${T})`.execute(db);
}

const column = sql<{
  nullable: string;
  type: string;
}>`select is_nullable as nullable, data_type as type from information_schema.columns
   where table_name = 'profile_versions' and column_name = 'environment_id'`;

describe("the profile environment migration", () => {
  // #919-M01
  it("leaves every version written before it with no environment", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    await sql`insert into profile_versions (profile_id, version, workspace_id, description, model_choice, instructions, can_push, created_by, created_at)
      values ('p-1', 1, 'w-1', '', '{"model":"m","provider":"p"}', '', 1, 'u-1', ${T})`.execute(
      db,
    );

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(
      await db.selectFrom("profile_versions").selectAll().execute(),
    ).toEqual([expect.objectContaining({ version: 1, environment_id: null })]);
    await db.destroy();
  });

  // #919-M01
  it("adds a nullable text column", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    expect((await column.execute(db)).rows).toEqual([
      { nullable: "YES", type: "text" },
    ]);
    await db.destroy();
  });

  // #919-M02
  it("can be taken back", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const { migration } =
      await import("./20261107180000_add_profile_environment.ts");
    await migration.down?.(db);

    expect((await column.execute(db)).rows).toHaveLength(0);
    await db.destroy();
  });
});
