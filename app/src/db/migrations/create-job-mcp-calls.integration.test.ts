// SPDX-License-Identifier: LicenseRef-Proprietary

// #1055: the MCP call record migration is expand only. It adds one empty table (and an index of its own) to a database made by the previous
// release's migrations, changes no existing row and no existing table, ties a row to a job of its own workspace, refuses a row the table's checks
// forbid, and gives up loudly instead of making a writer wait when a lock on a table it points at is held.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import {
  connectPostgres,
  createEmptyTestDatabase,
} from "../../test-support/test-database.ts";

const THIS = "20261117160000_create_job_mcp_calls";
const NEWEST_BEFORE = "20261117150000_add_job_mcp_calls";
const T = "2026-11-17T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

async function rowsOfEveryOldTable(
  db: Kysely<Database>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (table.name === "job_mcp_calls") continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)} order by 1`.execute(
        db,
      );
    result[table.name] = rows;
  }
  return result;
}

async function columnsOfEveryOldTable(
  db: Kysely<Database>,
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (table.name === "job_mcp_calls") continue;
    result[table.name] = table.columns.map((column) => column.name).sort();
  }
  return result;
}

async function seed(db: Kysely<Database>) {
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', null, ${T})`.execute(
    db,
  );
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-2', 'other', 'other', null, ${T})`.execute(
    db,
  );
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, credentials, webhook_secret, status, created_at, updated_at)
    values ('i-1', 'w-1', 'github_app', 'acme', '4242', '{}', null, null, 'active', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
    values ('r-1', 'w-1', 'i-1', '7001', 'acme/widgets', 'https://github.test/acme/widgets', 1, ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args, trigger_kind, actor_login, delivery_id, status, run_after, attempts, created_at, updated_at)
    values ('j-1', 'w-1', 'r-1', 8, 'https://github.test/acme/widgets/pull/8', ${"a".repeat(40)}, 'review', '', 'webhook', 'octocat', 'd-1', 'running', ${T}, 0, ${T}, ${T})`.execute(
    db,
  );
}

const insert = (
  db: Kysely<Database>,
  over: {
    job?: string;
    workspace?: string;
    status?: number;
    outcome?: string;
    duration?: number;
    tool?: string;
  } = {},
) =>
  sql`insert into job_mcp_calls (job_id, workspace_id, server_id, server_name, rpc_method, tool, status, outcome, duration_ms, request_bytes, response_bytes, created_at)
    values (${over.job ?? "j-1"}, ${over.workspace ?? "w-1"}, 's-1', 'Linear', 'tools/call', ${over.tool ?? "get_issue"}, ${over.status ?? 200}, ${over.outcome ?? "ok"}, ${over.duration ?? 5}, 1, 1, ${T})`.execute(
    db,
  );

describe("the MCP call record migration", () => {
  // #1055-T09
  it("sorts after the newest migration that was merged before it, so Kysely runs it", () => {
    expect(THIS > NEWEST_BEFORE).toBe(true);
  });

  // #1055-T09
  it("adds one empty table to an existing database with data and changes no existing row or table", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seed(db);
    const before = await rowsOfEveryOldTable(db);
    const columnsBefore = await columnsOfEveryOldTable(db);

    const { executed } = await migrateToLatest(db, migrationProvider);

    expect(executed).toContain(THIS);
    expect(await rowsOfEveryOldTable(db)).toEqual(before);
    expect(await columnsOfEveryOldTable(db)).toEqual(columnsBefore);
    const { rows } = await sql<{
      count: number;
    }>`select count(*)::int as count from job_mcp_calls`.execute(db);
    expect(rows).toEqual([{ count: 0 }]);
    expect((await migrateToLatest(db, migrationProvider)).executed).toEqual([]);
    await db.destroy();
  });

  // #1055-T09
  it("has an identity key, an index for reading a job's calls after a seq, and a composite key to jobs", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const constraints = await sql<{
      conname: string;
      definition: string;
    }>`select conname, pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'job_mcp_calls'::regclass order by conname`.execute(db);
    const byName = Object.fromEntries(
      constraints.rows.map((row) => [row.conname, row.definition]),
    );
    expect(byName["job_mcp_calls_pkey"]).toBe("PRIMARY KEY (seq)");
    expect(byName["job_mcp_calls_job_fk"]).toBe(
      "FOREIGN KEY (job_id, workspace_id) REFERENCES jobs(id, workspace_id)",
    );
    const indexes = await sql<{
      indexdef: string;
    }>`select indexdef from pg_indexes where tablename = 'job_mcp_calls'`.execute(
      db,
    );
    expect(indexes.rows.map((row) => row.indexdef)).toContainEqual(
      expect.stringContaining("(job_id, seq)"),
    );
    await db.destroy();
  });

  // #1055-T09
  it("takes a call of the job's own workspace and refuses one that names another workspace, a missing job, a bad status, a bad outcome and a negative number", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await expect(insert(db)).resolves.toBeDefined();
    await expect(insert(db, { workspace: "w-2" })).rejects.toThrow(
      /job_mcp_calls_job_fk/,
    );
    await expect(insert(db, { job: "no-job" })).rejects.toThrow(
      /job_mcp_calls_job_fk/,
    );
    await expect(insert(db, { status: 99 })).rejects.toThrow(
      /job_mcp_calls_status_check/,
    );
    await expect(insert(db, { outcome: "Bad Outcome; drop" })).rejects.toThrow(
      /job_mcp_calls_outcome_check/,
    );
    await expect(insert(db, { duration: -1 })).rejects.toThrow(
      /job_mcp_calls_numbers_check/,
    );
    await expect(insert(db, { tool: "x".repeat(101) })).rejects.toThrow(
      /job_mcp_calls_texts_check/,
    );
    await db.destroy();
  });

  // #1055-T09
  it("gives up with MIGRATION_FAILED and leaves nothing half applied when a writer keeps workspaces locked, then succeeds once it is gone", async () => {
    const { db, url } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seed(db);
    const writer = connectPostgres(url, 1).db;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const writerDone = writer.transaction().execute(async (trx) => {
      await sql`update workspaces set name = 'renamed' where id = 'w-1'`.execute(
        trx,
      );
      started();
      await held;
    });
    await writing;

    const startedAt = Date.now();
    await expect(migrateToLatest(db, migrationProvider)).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
    });

    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(
      (await db.introspection.getTables()).map((entry) => entry.name),
    ).not.toContain("job_mcp_calls");
    release();
    await writerDone;
    await expect(migrateToLatest(db, migrationProvider)).resolves.toMatchObject(
      { executed: expect.arrayContaining([THIS]) },
    );
    await writer.destroy();
    await db.destroy();
  });
});
