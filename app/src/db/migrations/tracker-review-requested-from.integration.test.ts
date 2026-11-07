// SPDX-License-Identifier: LicenseRef-Proprietary

// #924: the migration adds `tracker_items.review_requested_from` (null for every row that exists, read as nobody until a delivery or the
// sync says who is asked) and `review_acted_by` (who acted on a review ToDo while the request stood), both bounded in size. Expand only;
// `down` takes them back.
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { migration } from "./20261107210000_tracker_review_requested_from.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261107210000_tracker_review_requested_from";
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

const column = sql<{
  name: string;
}>`select column_name as name from information_schema.columns
  where table_schema = 'public' and table_name = 'tracker_items'
    and column_name in ('review_requested_from', 'review_acted_by') order by column_name`;

describe("the column of who a review is asked from", () => {
  // #924-T06
  it("leaves the rows that exist null and bounds what is stored", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
    await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'w', 'w', 'u-1', ${T})`.execute(
      db,
    );
    await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
      values ('i-1', 'w-1', 'github_app', 'w', 'ext', '{}', 'active', ${T}, ${T})`.execute(
      db,
    );
    await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
      values ('r-1', 'w-1', 'i-1', 'ext-r', 'acme/a', 'https://github.test/acme/a', 1, ${T}, ${T})`.execute(
      db,
    );
    await sql`insert into tracker_items (workspace_id, repository_id, project_id, provider, repo, number, node_id, kind, state, title, updated_at, synced_at)
      values ('w-1', 'r-1', null, 'github', 'acme/a', 1, 'PR_1', 'pull_request', 'open', 'A pull request', ${T}, ${T})`.execute(
      db,
    );

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    const rows = await sql<{
      review_requested_from: string | null;
      review_acted_by: string | null;
    }>`select review_requested_from, review_acted_by from tracker_items`.execute(
      db,
    );
    expect(rows.rows).toEqual([
      { review_requested_from: null, review_acted_by: null },
    ]);
    await sql`update tracker_items set review_requested_from = '["ada"]', review_acted_by = '["ada"]'`.execute(
      db,
    );
    await expect(
      sql`update tracker_items set review_requested_from = ${"x".repeat(4097)}`.execute(
        db,
      ),
    ).rejects.toThrow();
    await expect(
      sql`update tracker_items set review_acted_by = ${"x".repeat(4097)}`.execute(
        db,
      ),
    ).rejects.toThrow();
    await db.destroy();
  });

  // #924-T07
  it("is undone by `down`, and comes back by running it again", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    await migration.down?.(db);
    expect((await column.execute(db)).rows).toEqual([]);

    await migration.up(db);
    expect((await column.execute(db)).rows).toEqual([
      { name: "review_acted_by" },
      { name: "review_requested_from" },
    ]);
    await db.destroy();
  });
});
