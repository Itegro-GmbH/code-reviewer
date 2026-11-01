// SPDX-License-Identifier: LicenseRef-Proprietary

// #493: the job VM runs migration is expand only: it adds an empty table to a database made by the previous release's
// migrations and changes no existing row, and the table holds the key and the checks the repository relies on.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { MigrationProvider } from "kysely/migration";
import type { Database } from "../schema.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const SPLIT = "20261019160000_create_job_vm_runs";

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
      table.name === "job_vm_runs" ||
      table.name === "billing_topup_intents" ||
      table.name === "models_dev_providers" ||
      table.name === "models_dev_models" ||
      table.name === "models_dev_fetch_state" ||
      table.name === "model_enablements" ||
      table.name === "model_price_confirmations" ||
      table.name === "billing_webhook_events" ||
      table.name === "billing_profiles" ||
      table.name === "billing_start_credit_grants" ||
      table.name === "billing_workspace_settings" ||
      table.name === "billing_notifications" ||
      table.name === "implementer_sessions" ||
      table.name === "implementer_turns"
    )
      continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)}`.execute(db);
    result[table.name] = withoutColumnsAddedLater(table.name, rows);
  }
  return result;
}

describe("the job VM runs migration", () => {
  // #493-T11
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
    ).not.toContain("job_vm_runs");

    await migrateToLatest(db, migrationProvider);

    expect(await rowsOfEveryTable(db)).toEqual(before);
    const { rows } = await sql<{
      count: number;
    }>`select count(*)::int as count from job_vm_runs`.execute(db);
    expect(rows).toEqual([{ count: 0 }]);
    await db.destroy();
  });

  // #493-T11
  it("refuses a row for a job that does not exist", async () => {
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
    const insert = (jobId: string) =>
      sql`insert into job_vm_runs (job_id, vm_name, workspace_id, attempt, claimed_at, started_at, reported_at, created_at, updated_at)
        values (${jobId}, 'vm', 'w-1', 1, ${T}, ${T}, ${T}, ${T}, ${T})`.execute(
        db,
      );

    await expect(insert("no-such-job")).rejects.toThrow();
    await db.destroy();
  });
});
