// SPDX-License-Identifier: LicenseRef-Proprietary

// #271-T07: the entitlements migration adds the table to a database made by the previous release's
// migrations and changes no existing row. A workspace without a row stays unlimited.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { MigrationProvider } from "kysely/migration";
import type { Database } from "../schema.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const SPLIT = "20261014120000_create_workspace_entitlements";

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

async function snapshot(
  db: Kysely<Database>,
): Promise<Record<string, unknown[]>> {
  const tables = await db.introspection.getTables();
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    // The table of this migration, and the ones that later migrations added.
    if (table.name === "workspace_entitlements") continue;
    if (
      table.name === "usage_records" ||
      table.name === "setup_codes" ||
      table.name === "job_dispatches" ||
      table.name === "refusal_notices" ||
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

describe("the entitlements migration", () => {
  // #271-T07
  it("adds the table to an existing database and changes no existing row", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await db
      .insertInto("workspaces")
      .values([
        {
          id: "w-1",
          name: "acme",
          slug: "acme",
          created_by: null,
          created_at: T,
        },
        {
          id: "w-2",
          name: "beta",
          slug: "beta",
          created_by: null,
          created_at: T,
        },
      ])
      .execute();
    await db
      .insertInto("instance_settings")
      .values({
        key: "tenancy",
        value: '"multi"',
        updated_by: null,
        updated_at: T,
      })
      .execute();
    const before = await snapshot(db);
    expect(
      (await db.introspection.getTables()).map((table) => table.name),
    ).not.toContain("workspace_entitlements");

    await migrateToLatest(db, migrationProvider);

    expect(await snapshot(db)).toEqual(before);
    const { rows } = await sql<{
      count: number;
    }>`select count(*)::int as count from workspace_entitlements`.execute(db);
    expect(rows).toEqual([{ count: 0 }]);
    await db.destroy();
  });
});
