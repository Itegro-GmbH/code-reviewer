// SPDX-License-Identifier: LicenseRef-Proprietary

// #856: the usage record migration is expand only. It adds one nullable column that says a turn ran through a subscription (it has no
// cost to be unknown); every record written before it reads null, only that one word is accepted, and the migration can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261105233000_add_usage_record_cost_basis";
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

async function seedJob(db: Kysely<Database>, id: string) {
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
  await sql`insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args, trigger_kind, actor_login, delivery_id, status, run_after, attempts, created_at, updated_at, review_kind)
    values (${id}, 'w-1', 'r-1', ${Number(id.slice(-1))}, 'https://github.test/acme/widgets/pull/1', ${"a".repeat(40)}, 'review', '', 'webhook', 'octocat', ${`d-${id}`}, 'queued', ${T}, 0, ${T}, ${T}, 'diff')`.execute(
    db,
  );
}

const record = (id: string, jobId: string, basis: string | null) =>
  sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, state, reserved_at, cost_basis)
    values (${id}, 'w-1', ${jobId}, 'diff', 'own', 'reserved', ${T}, ${basis})`;

describe("the usage record cost basis migration", () => {
  // #856-M03
  it("leaves every record written before it with no basis", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seedJob(db, "j-1");
    await sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, state, reserved_at)
      values ('ur-1', 'w-1', 'j-1', 'diff', 'own', 'reserved', ${T})`.execute(
      db,
    );

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(await db.selectFrom("usage_records").selectAll().execute()).toEqual([
      expect.objectContaining({ id: "ur-1", cost_basis: null }),
    ]);
    await db.destroy();
  });

  // #856-M03
  it("takes the one basis and refuses another word", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    for (const id of ["j-1", "j-2", "j-3", "j-4"]) await seedJob(db, id);

    await record("ur-1", "j-1", "subscription").execute(db);
    await record("ur-2", "j-2", null).execute(db);
    await expect(
      record("ur-3", "j-3", "reported").execute(db),
    ).rejects.toThrow();
    await expect(record("ur-4", "j-4", "").execute(db)).rejects.toThrow();
    await db.destroy();
  });

  // #856-M03
  it("can be taken back", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    const columns = sql<{
      name: string;
    }>`select column_name as name from information_schema.columns
       where table_name = 'usage_records' and column_name = 'cost_basis'`;
    expect((await columns.execute(db)).rows).toHaveLength(1);

    const { migration } =
      await import("./20261105233000_add_usage_record_cost_basis.ts");
    await migration.down?.(db);

    expect((await columns.execute(db)).rows).toHaveLength(0);
    await db.destroy();
  });
});
