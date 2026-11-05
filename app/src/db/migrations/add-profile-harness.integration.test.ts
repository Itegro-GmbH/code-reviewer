// SPDX-License-Identifier: LicenseRef-Proprietary

// #856: the profile harness migration is expand only. It adds one nullable column to the profile versions and one to the turns, every
// version written before it reads null (OpenCode), only the two harnesses are accepted, a turn has a harness only with a profile, and
// the migration can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261105230000_add_profile_harness";
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
  await sql`insert into profiles (id, workspace_id, name, current_version, created_by, created_at, updated_at)
    values ('p-1', 'w-1', 'writer', 1, 'u-1', ${T}, ${T})`.execute(db);
}

const version = (number: number, harness: string | null) =>
  sql`insert into profile_versions (profile_id, version, workspace_id, description, model_choice, instructions, can_push, harness, created_by, created_at)
    values ('p-1', ${number}, 'w-1', '', '{"model":"m","provider":"p"}', '', 1, ${harness}, 'u-1', ${T})`;

describe("the profile harness migration", () => {
  // #856-M01
  it("leaves every version written before it with no harness, which reads as OpenCode", async () => {
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
    ).toEqual([expect.objectContaining({ version: 1, harness: null })]);
    await db.destroy();
  });

  // #856-M01
  it("takes the two harnesses and refuses another one", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await version(1, "opencode").execute(db);
    await version(2, "claude-code").execute(db);
    await version(3, null).execute(db);

    await expect(version(4, "codex").execute(db)).rejects.toThrow();
    await expect(version(5, "").execute(db)).rejects.toThrow();
    await db.destroy();
  });

  // #856-M01
  it("gives a turn a harness column that only a turn with a profile may fill", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const { rows } = await sql<{
      name: string;
      definition: string;
    }>`select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'implementer_turns_profile_harness_check'`.execute(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toContain("profile_id IS NOT NULL");
    await db.destroy();
  });

  // #856-M02
  it("can be taken back", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    const columns = sql<{
      name: string;
    }>`select table_name || '.' || column_name as name from information_schema.columns
       where (table_name = 'profile_versions' and column_name = 'harness')
          or (table_name = 'implementer_turns' and column_name = 'profile_harness')`;
    expect((await columns.execute(db)).rows).toHaveLength(2);

    const { migration } =
      await import("./20261105230000_add_profile_harness.ts");
    await migration.down?.(db);

    expect((await columns.execute(db)).rows).toHaveLength(0);
    await db.destroy();
  });
});
