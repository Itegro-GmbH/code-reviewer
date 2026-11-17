// SPDX-License-Identifier: LicenseRef-Proprietary

// #1053: the migration that adds the MCP call counter must run on a database made by the previous release's migrations, keep every job and
// give each one a count of 0, and leave the default in place so that an older app instance, which does not name the column, still inserts jobs.
import { describe, expect, it } from "vitest";
import type { MigrationProvider } from "kysely/migration";
import { migrateToLatest } from "../migrate.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import { migrationProvider } from "./index.ts";

const THIS_MIGRATION = "20261117150000_add_job_mcp_calls";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS_MIGRATION,
      ),
    );
  },
};

const T = "2026-10-15T08:00:00.000Z";

describe("the migration of the MCP call counter", () => {
  // #1053-T14
  it("gives every existing job a count of 0 and keeps its lease token", async () => {
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
      await db
        .insertInto("integrations")
        .values({
          id: "i-1",
          workspace_id: "w-1",
          type: "github_app",
          display_name: "acme",
          external_id: "4242",
          config: "{}",
          credentials: null,
          webhook_secret: null,
          status: "active",
          created_at: T,
          updated_at: T,
        })
        .execute();
      await db
        .insertInto("repositories")
        .values({
          id: "r-1",
          workspace_id: "w-1",
          integration_id: "i-1",
          external_id: "7001",
          full_name: "acme/widgets",
          url: "https://github.test/acme/widgets",
          active: 1,
          created_at: T,
          updated_at: T,
        })
        .execute();
      await db
        .insertInto("jobs")
        .values({
          id: "j-running",
          workspace_id: "w-1",
          repository_id: "r-1",
          pr_number: 8,
          pr_url: "https://github.test/acme/widgets/pull/8",
          head_sha: "a".repeat(40),
          command: "review",
          args: "",
          trigger_kind: "webhook",
          actor_login: "octocat",
          delivery_id: "d-1",
          status: "running",
          run_after: T,
          attempts: 0,
          runner_id: "runner-1",
          lease_token: "lease-1",
          claimed_at: T,
          heartbeat_at: T,
          lease_expires_at: T,
          result: null,
          error_code: null,
          superseded_by: null,
          created_at: T,
          updated_at: T,
          finished_at: null,
        })
        .execute();

      await migrateToLatest(db, migrationProvider);

      const rows = await db.selectFrom("jobs").selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "j-running",
        lease_token: "lease-1",
        mcp_calls: 0,
        worker_fetches: 0,
      });
    } finally {
      await db.destroy();
    }
  });
});
