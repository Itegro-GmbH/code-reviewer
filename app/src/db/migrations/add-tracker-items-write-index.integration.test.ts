// SPDX-License-Identifier: LicenseRef-Proprietary

// #937: the issue list reads `max(synced_at)` of a repository's rows (`lastWriteAt`) on every poll. `tracker_items_written_index` is an
// index on `(workspace_id, repository_id, synced_at desc)`, so that read is the first entry of the index. Additive (an index, no column,
// no row): the rows of an existing database are untouched, and the migration can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import type { Database } from "../schema.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { migration } from "./20261107230000_add_tracker_items_write_index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261107230000_add_tracker_items_write_index";
const T = "2026-11-07T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

type Db = Kysely<Database>;

async function seedItem(db: Db) {
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
  await sql`insert into tracker_items (workspace_id, repository_id, provider, repo, number, node_id, kind, state, title, body_excerpt, labels, assignees, pull_requests, closes, updated_at, synced_at)
    values ('w-1', 'r-1', 'github', 'acme/widgets', 1, 'I_1', 'issue', 'open', 'Title', '', '[]', '[]', '[]', '[]', ${T}, ${T})`.execute(
    db,
  );
}

describe("the index of the ticket mirror's last write", () => {
  // #937-T20
  it("is added, keeps the rows, answers the read of lastWriteAt, and is taken back by down", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seedItem(db);

    await migrateToLatest(db);

    const { rows: kept } = await sql<{
      newest: string;
    }>`select max(synced_at) as newest from tracker_items where workspace_id = 'w-1' and repository_id = 'r-1'`.execute(
      db,
    );
    expect(kept[0]?.newest).toBe(T);
    const { rows: indexes } = await sql<{
      indexdef: string;
    }>`select indexdef from pg_indexes where indexname = 'tracker_items_written_index'`.execute(
      db,
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain(
      "(workspace_id, repository_id, synced_at DESC)",
    );
    // With the sequential scan out of the way, the planner shows that the index can answer the query.
    const plan = await db.transaction().execute(async (trx) => {
      await sql`set local enable_seqscan = off`.execute(trx);
      const { rows } = await sql<
        Record<string, string>
      >`explain select max(synced_at) from tracker_items where workspace_id = 'w-1' and repository_id = 'r-1'`.execute(
        trx,
      );
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("tracker_items_written_index");

    await migration.down?.(db);
    const { rows: gone } =
      await sql`select 1 from pg_indexes where indexname = 'tracker_items_written_index'`.execute(
        db,
      );
    expect(gone).toHaveLength(0);
    await migration.up(db);
  });
});
