// SPDX-License-Identifier: LicenseRef-Proprietary

// #1092: the session repos migration is expand only. It adds one nullable text column for the repositories of a session of several
// repositories; every session written before it reads null (one repository), and the migration can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261118160000_add_implementer_session_repos";
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

async function seedSession(db: Kysely<Database>, id: string, branch: string) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T}) on conflict do nothing`.execute(
    db,
  );
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T}) on conflict do nothing`.execute(
    db,
  );
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
    values ('i-1', 'w-1', 'github_app', 'acme', 'ext-1', '{}', 'active', ${T}, ${T}) on conflict do nothing`.execute(
    db,
  );
  await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
    values ('r-1', 'w-1', 'i-1', 'repo-1', 'acme/widgets', 'https://github.test/acme/widgets', 1, ${T}, ${T}) on conflict do nothing`.execute(
    db,
  );
  await sql`insert into implementer_sessions (id, workspace_id, repository_id, slot, base_branch, branch, status, created_by, created_at, updated_at)
    values (${id}, 'w-1', 'r-1', ${Number(id.slice(-1))}, 'main', ${branch}, 'idle', 'u-1', ${T}, ${T})`.execute(
    db,
  );
}

describe("the implementer session repos migration", () => {
  // #1092-M01
  it("leaves every session written before it with no repositories", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seedSession(db, "s-1", "implementer/a");

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(
      await db.selectFrom("implementer_sessions").selectAll().execute(),
    ).toEqual([
      expect.objectContaining({
        id: "s-1",
        base_branch: "main",
        repos: null,
      }),
    ]);
    await db.destroy();
  });

  // #1092-M01
  it("stores the repositories of a new session beside its first", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seedSession(db, "s-1", "implementer/a");

    await db
      .updateTable("implementer_sessions")
      .set({ repos: '[{"repositoryId":"r-1"}]' })
      .where("id", "=", "s-1")
      .execute();

    expect(
      await db
        .selectFrom("implementer_sessions")
        .select(["base_branch", "repos"])
        .execute(),
    ).toEqual([{ base_branch: "main", repos: '[{"repositoryId":"r-1"}]' }]);
    await db.destroy();
  });

  // #1092-M01
  it("can be taken back", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    const columns = sql<{
      name: string;
    }>`select column_name as name from information_schema.columns
       where table_name = 'implementer_sessions' and column_name = 'repos'`;
    expect((await columns.execute(db)).rows).toHaveLength(1);

    const { migration } =
      await import("./20261118160000_add_implementer_session_repos.ts");
    await migration.down?.(db);

    expect((await columns.execute(db)).rows).toHaveLength(0);
    await db.destroy();
  });
});
