// SPDX-License-Identifier: LicenseRef-Proprietary

// #432-T20: the migration adds three nullable columns to `usage_records` of a database made by the previous release's
// migrations. Every existing record stays as it is (the new columns read NULL, `model_tier` is untouched); an app of the
// previous release, which never names the columns, still reserves and settles records.
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";

const SPLIT = "20261018090000_add_usage_record_catalog_entry";
const COLUMNS = ["catalog_entry_id", "catalog_entry_name", "llm_provider"];

/** The migrations the previous release's database ran: everything before the new one. */
const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < SPLIT,
      ),
    );
  },
};

const T = "2026-10-18T08:00:00.000Z";

describe("the usage record catalog entry migration", () => {
  // #432-T20
  it("adds only nullable columns and leaves the existing records as they were", async () => {
    const { db } = await createEmptyTestDatabase();
    try {
      await migrateToLatest(db, beforeThisMigration);
      await db
        .insertInto("workspaces")
        .values({
          id: "w-1",
          name: "acme",
          slug: "acme",
          created_by: null,
          created_at: T,
        })
        .execute();
      // A record belongs to a job; only the columns of the record are under test.
      await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
        values ('i-1', 'w-1', 'github_app', 'acme', '1', '{}', 'active', ${T}, ${T})`.execute(
        db,
      );
      await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
        values ('r-1', 'w-1', 'i-1', '1', 'acme/widgets', 'https://github.test/acme/widgets', 1, ${T}, ${T})`.execute(
        db,
      );
      await sql`insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args, trigger_kind, actor_login, status, run_after, attempts, created_at, updated_at)
        values ('job-1', 'w-1', 'r-1', 7, 'https://github.test/acme/widgets/pull/7', ${"a".repeat(40)}, 'review', '', 'webhook', 'octocat', 'queued', ${T}, 0, ${T}, ${T}),
        ('job-2', 'w-1', 'r-1', 8, 'https://github.test/acme/widgets/pull/8', ${"b".repeat(40)}, 'review', '', 'webhook', 'octocat', 'queued', ${T}, 0, ${T}, ${T})`.execute(
        db,
      );
      await sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, model_tier, state, reserved_at)
        values ('u-1', 'w-1', 'job-1', 'diff', 'managed', 'high', 'reserved', ${T})`.execute(
        db,
      );
      const { rows: before } = await sql<
        Record<string, unknown>
      >`select * from usage_records`.execute(db);

      await migrateToLatest(db, migrationProvider);

      const { rows: after } = await sql<
        Record<string, unknown>
      >`select * from usage_records`.execute(db);
      expect(after).toEqual([
        {
          ...before[0],
          catalog_entry_id: null,
          catalog_entry_name: null,
          llm_provider: null,
          // Added by a later migration (#605).
          billing_state: null,
          // Added by a later migration (#856).
          cost_basis: null,
        },
      ]);
      const table = (await db.introspection.getTables()).find(
        (candidate) => candidate.name === "usage_records",
      );
      for (const name of COLUMNS)
        expect(
          table?.columns.find((candidate) => candidate.name === name),
        ).toMatchObject({
          isNullable: true,
          hasDefaultValue: false,
          dataType: "text",
        });
      // An app of the previous release inserts a record without naming the columns.
      await sql`insert into usage_records (id, workspace_id, job_id, review_kind, key_mode, state, reserved_at)
        values ('u-2', 'w-1', 'job-2', 'diff', 'own', 'reserved', ${T})`.execute(
        db,
      );
      expect(
        await db
          .selectFrom("usage_records")
          .select(["catalog_entry_id", "catalog_entry_name", "llm_provider"])
          .where("id", "=", "u-2")
          .execute(),
      ).toEqual([
        {
          catalog_entry_id: null,
          catalog_entry_name: null,
          llm_provider: null,
        },
      ]);
    } finally {
      await db.destroy();
    }
  });
});
