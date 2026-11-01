// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the schema bootstrap: an empty database is fully migrated, a second start changes nothing, a failing
// migration leaves no trace, and the migrated schema follows the column conventions.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import {
  createEmptyTestDatabase,
  createTestDatabase,
  track,
} from "../test-support/test-database.ts";
import { DatabaseError } from "./errors.ts";
import { migrateToLatest } from "./migrate.ts";
import { migrationProvider } from "./migrations/index.ts";
import { createAppMetaRepository } from "./repositories/app-meta-repository.ts";
import type { Database } from "./schema.ts";
import { startDatabase } from "../test-support/start-database.ts";

async function names(db: Kysely<Database>, query: string): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`${sql.raw(query)}`.execute(db);
  return rows.map((row) => row.name);
}

async function userTables(db: Kysely<Database>): Promise<string[]> {
  return names(
    db,
    "select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
  );
}

describe("the list of migrations", () => {
  it("names every migration after the first with a UTC timestamp prefix", async () => {
    const keys = Object.keys(await migrationProvider.getMigrations()).sort();

    expect(keys[0]).toBe("0001_create_app_meta");
    for (const key of keys.slice(1))
      expect(key, key).toMatch(/^\d{14}_[a-z0-9_]+$/);
  });
});

describe("the migrations of both epics", () => {
  // CR-43-T01
  it("run on an empty database in one fixed, ascending order: login tables first, then the GitHub integration", async () => {
    const { db } = await createEmptyTestDatabase();

    const { executed: migrationsApplied } = await migrateToLatest(db);

    expect(migrationsApplied).toEqual([
      "0001_create_app_meta",
      "20261010123800_create_auth_tables",
      "20261010125500_add_user_org_checked_at",
      "20261010131500_add_user_org_checked_for",
      "20261010133000_create_allowed_login_pins",
      "20261010134000_create_integrations",
      "20261010143000_create_repositories",
      "20261010170000_create_webhook_deliveries",
      "20261010190000_create_projects",
      "20261010191500_create_jobs",
      "20261010201500_create_app_settings",
      "20261011090000_create_job_comments",
      "20261011100000_add_jobs_repository_recent_index",
      "20261011160000_create_workspaces",
      "20261011160100_add_workspace_to_customer_data",
      "20261011160200_prepare_users_for_accounts",
      "20261011170000_create_instance_settings",
      "20261011170100_create_rate_limits",
      "20261011170200_add_instance_admin_flag_to_users",
      "20261011200000_create_secrets",
      "20261011200100_create_password_reset_tokens",
      "20261011210000_create_email_verification_tokens",
      "20261012100000_create_invitations",
      "20261012120000_create_signed_states",
      "20261012120100_add_users_email_conflict",
      "20261012120200_unique_accounts",
      "20261012140000_create_workspace_secrets",
      "20261012140100_create_job_claimed_keys",
      "20261012150000_create_installation_binding",
      "20261012160000_remove_commands",
      "20261013090000_add_job_review_kind",
      "20261014090000_fix_dynamic_default_model",
      "20261014120000_create_workspace_entitlements",
      "20261014150000_create_usage_records",
      "20261015100000_add_job_worker_fetches",
      "20261015110000_create_setup_codes",
      "20261015120000_create_job_dispatches",
      "20261015200000_add_usage_record_settled_reason",
      "20261016090000_create_refusal_notices",
      "20261016120000_create_plan_handoff_tokens",
      "20261016140000_add_job_accepts_supersede",
      "20261016140100_widen_usage_record_settled_reason",
      "20261017100000_create_job_check_runs",
      "20261017140000_create_model_catalog_entries",
      "20261017160000_add_workspace_entitlements_model_access",
      "20261018090000_add_usage_record_catalog_entry",
      "20261018170000_migrate_model_tiers_to_catalog",
      "20261019150000_create_billing_journal",
      "20261019160000_create_job_vm_runs",
      "20261019170000_create_billing_topup_intents",
      "20261019183000_add_jobs_created_at_index",
      "20261019200000_create_models_dev_catalog",
      "20261020090000_create_model_decisions",
      "20261021090000_widen_refusal_notice_codes",
      "20261021090100_widen_job_vm_runs_end_source",
      "20261021120000_add_billing_balances_reserved_index",
      "20261021130000_create_billing_profiles",
      "20261021150000_create_billing_start_credit_grants",
      "20261021170000_add_billing_topup_intents_provider_amount",
      "20261021190000_add_billing_topup_intents_provider_currency",
      "20261021190100_add_billing_webhook_events_review_context",
      "20261021210000_widen_refusal_notice_codes_for_limits",
      "20261021210100_create_billing_workspace_settings",
      "20261021210200_add_limit_query_indexes",
      "20261022010000_add_usage_record_billing_state",
      "20261022020000_add_billing_webhook_events_resolution",
      "20261022030000_create_billing_notifications",
      "20261023090000_widen_refusal_notice_codes_for_billing_setup",
      "20261023120000_add_job_check_runs_review_comment",
      "20261023150000_add_workspace_deleted_at",
      "20261023160000_add_jobs_superseded_by_index",
      "20261025140000_add_users_posthog_identity",
      "20261030140000_create_implementer_sessions_and_turns",
      "20261030190000_widen_review_kind_checks_for_implementer",
    ]);
  });

  // CR-43-T01
  it("have unique names and a registered file each, so no two branches can share a slot", async () => {
    const files = readdirSync(join(import.meta.dirname, "migrations"))
      .filter((name) => /^\d.*\.ts$/.test(name) && !name.includes(".test."))
      .map((name) => name.replace(/\.ts$/, ""))
      .sort();
    const keys = Object.keys(await migrationProvider.getMigrations()).sort();

    expect(keys).toEqual(files);
    expect(new Set(keys.map((key) => key.slice(0, 14))).size).toBe(keys.length);
  });
});

describe("starting the database", () => {
  // CR-15-T01
  it("applies every migration in order to an empty database", async () => {
    const expectedMigrations = Object.keys(
      await migrationProvider.getMigrations(),
    ).sort();

    const { db } = await createEmptyTestDatabase();
    const { executed: migrationsApplied } = await migrateToLatest(db);

    expect(migrationsApplied).toEqual(expectedMigrations);
    expect(
      await names(db, "select name from kysely_migration order by name"),
    ).toEqual(expectedMigrations);
    expect(await userTables(db)).toEqual([
      "accounts",
      "allowed_login_pins",
      "app_meta",
      "app_settings",
      "billing_balances",
      "billing_journal_entries",
      "billing_notifications",
      "billing_profiles",
      "billing_start_credit_grants",
      "billing_topup_intents",
      "billing_webhook_events",
      "billing_workspace_settings",
      "email_verification_tokens",
      "implementer_sessions",
      "implementer_turns",
      "installation_link_requests",
      "instance_settings",
      "integrations",
      "invitations",
      "job_check_runs",
      "job_claimed_keys",
      "job_comments",
      "job_dispatches",
      "job_vm_runs",
      "jobs",
      "kysely_migration",
      "kysely_migration_lock",
      "model_catalog_entries",
      "model_enablements",
      "model_price_confirmations",
      "models_dev_fetch_state",
      "models_dev_models",
      "models_dev_providers",
      "password_reset_tokens",
      "plan_handoff_tokens",
      "projects",
      "rate_limits",
      "refusal_notices",
      "repositories",
      "secrets",
      "sessions",
      "setup_codes",
      "signed_states",
      "unclaimed_installations",
      "usage_records",
      "users",
      "verifications",
      "webhook_deliveries",
      "workspace_entitlements",
      "workspace_members",
      "workspace_secrets",
      "workspaces",
    ]);
    const { rows } = await sql<{
      name: string;
      type: string;
      nullable: string;
    }>`select column_name as name, data_type as type, is_nullable as nullable
       from information_schema.columns
       where table_schema = 'public' and table_name = 'app_meta'
       order by ordinal_position`.execute(db);
    expect(rows).toEqual([
      { name: "key", type: "text", nullable: "NO" },
      { name: "value", type: "text", nullable: "NO" },
      { name: "updated_at", type: "text", nullable: "NO" },
    ]);
  });

  // CR-15-T02
  it("applies nothing and keeps the data when the file is already migrated", async () => {
    const { db: first, config } = await createTestDatabase();
    await createAppMetaRepository(first).set("greeting", "hello");
    const recorded =
      await sql`select name, timestamp from kysely_migration order by name`.execute(
        first,
      );

    const { db: second, migrationsApplied } = await startDatabase(config);
    track(second);

    expect(migrationsApplied).toEqual([]);
    expect(await createAppMetaRepository(second).get("greeting")).toBe("hello");
    expect(
      await sql`select name, timestamp from kysely_migration order by name`.execute(
        second,
      ),
    ).toEqual(recorded);
  });
});

describe("a failing migration", () => {
  const failingAfterCreatingATable: Migration = {
    async up(db) {
      await db.schema
        .createTable("half_built")
        .addColumn("id", "text", (c) => c.primaryKey())
        .execute();
      await sql`this is not valid sql`.execute(db);
    },
  };
  const provider: MigrationProvider = {
    async getMigrations() {
      return {
        ...(await migrationProvider.getMigrations()),
        "9999_broken": failingAfterCreatingATable,
      };
    },
  };

  // CR-15-T09
  it("stops with an error naming it, and rolls back the half-built table and the record", async () => {
    const { db } = await createTestDatabase();
    const before = await userTables(db);
    const recordedBefore = await names(
      db,
      "select name from kysely_migration order by name",
    );

    const run = migrateToLatest(db, provider);

    await expect(run).rejects.toBeInstanceOf(DatabaseError);
    await expect(run).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    await expect(run).rejects.toThrow(/9999_broken/);
    expect(await userTables(db)).toEqual(before);
    expect(
      await names(db, "select name from kysely_migration order by name"),
    ).toEqual(recordedBefore);
  });

  // CR-15-T09
  it("does not keep the migrations of the same start that ran before it", async () => {
    const { db } = await createEmptyTestDatabase();

    await expect(migrateToLatest(db, provider)).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
    });

    expect(await userTables(db)).not.toContain("app_meta");
    expect(await userTables(db)).not.toContain("half_built");
    expect(await names(db, "select name from kysely_migration")).toEqual([]);
  });
});

describe("the migrated schema", () => {
  const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  // CR-15-T06
  it("uses only text and integer columns (bigint for a sequence), text ids, and text timestamps", async () => {
    const { db } = await createTestDatabase();
    // Kysely's own bookkeeping tables are not ours to shape (varchar columns).
    const tables = (await userTables(db)).filter(
      (name) => !name.startsWith("kysely_"),
    );
    expect(tables.length).toBeGreaterThan(0);

    const { rows: columns } = await sql<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>`select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public' and table_name = any(${tables}::text[])`.execute(
      db,
    );
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      const where = `${column.table_name}.${column.column_name}`;
      expect(["text", "integer", "bigint"], where).toContain(column.data_type);
      if (column.column_name === "id" || column.column_name.endsWith("_id"))
        expect(column.data_type, where).toBe("text");
      if (column.column_name.endsWith("_at"))
        expect(column.data_type, where).toBe("text");
    }
  });

  // CR-15-T06
  it("stores timestamps written by a repository as ISO 8601 text in UTC", async () => {
    const { db } = await createTestDatabase();
    await createAppMetaRepository(
      db,
      () => new Date(Date.UTC(2026, 9, 10, 12, 30, 15, 42)),
    ).set("k", "v");

    const { rows } = await sql<{ updated_at: string; type: string }>`
      select updated_at, pg_typeof(updated_at)::text as type from app_meta`.execute(
      db,
    );

    expect(rows[0]?.type).toBe("text");
    expect(rows[0]?.updated_at).toBe("2026-10-10T12:30:15.042Z");
    expect(rows[0]?.updated_at).toMatch(ISO_UTC);
  });
});
