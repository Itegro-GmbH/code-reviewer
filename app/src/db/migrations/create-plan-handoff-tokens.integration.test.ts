// SPDX-License-Identifier: LicenseRef-Proprietary

// #284: the plan handoff tokens migration adds an empty table to a database made by the previous release's migrations
// and changes no existing row, and the table keeps only what the redemption relies on.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { MigrationProvider } from "kysely/migration";
import type { Database } from "../schema.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const SPLIT = "20261016120000_create_plan_handoff_tokens";

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

const T = "2026-10-12T08:00:00.000Z";

async function rowsOfEveryTable(
  db: Kysely<Database>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (
      table.name === "plan_handoff_tokens" ||
      table.name === "job_check_runs" ||
      table.name === "model_catalog_entries" ||
      table.name === "billing_journal_entries" ||
      table.name === "billing_balances" ||
      table.name === "billing_start_credit_grants" ||
      table.name === "billing_workspace_settings" ||
      table.name === "billing_notifications" ||
      table.name === "implementer_sessions" ||
      table.name === "implementer_turns" ||
      table.name === "job_vm_runs" ||
      table.name === "billing_topup_intents" ||
      table.name === "models_dev_providers" ||
      table.name === "models_dev_models" ||
      table.name === "models_dev_fetch_state" ||
      table.name === "model_enablements" ||
      table.name === "model_price_confirmations" ||
      table.name === "billing_webhook_events" ||
      table.name === "billing_profiles"
    )
      continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)}`.execute(db);
    result[table.name] = withoutColumnsAddedLater(table.name, rows);
  }
  return result;
}

describe("the plan handoff tokens migration", () => {
  // #284 (no case of its own: the migration is not a behavior of the issue)
  it("adds an empty table to an existing database and changes no existing row", async () => {
    const { db } = await createEmptyTestDatabase();
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
    const before = await rowsOfEveryTable(db);
    expect(
      (await db.introspection.getTables()).map((table) => table.name),
    ).not.toContain("plan_handoff_tokens");

    await migrateToLatest(db, migrationProvider);

    expect(await rowsOfEveryTable(db)).toEqual(before);
    const { rows } = await sql<{
      count: number;
    }>`select count(*)::int as count from plan_handoff_tokens`.execute(db);
    expect(rows).toEqual([{ count: 0 }]);
    await db.destroy();
  });

  // #284-T06
  it("holds no token for a Member: the role is owner or admin", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
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
      .insertInto("users")
      .values({
        id: "u-1",
        name: "u",
        email: "u@example.com",
        email_verified: 1,
        created_at: T,
        updated_at: T,
      })
      .execute();

    await expect(
      db
        .insertInto("plan_handoff_tokens")
        .values({
          token_hash: "a".repeat(64),
          workspace_id: "w-1",
          user_id: "u-1",
          role: "member",
          created_at: T,
          expires_at: T,
          used_at: null,
          revoked_at: null,
        })
        .execute(),
    ).rejects.toThrow();
    await db.destroy();
  });
});
