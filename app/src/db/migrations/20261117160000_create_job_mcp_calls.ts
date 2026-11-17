// SPDX-License-Identifier: LicenseRef-Proprietary

// #1055 (epic #1049): the record of the MCP calls an agent made through the proxy of the Worker API (#1053), one row for each call and for each
// refusal of one, for the run's live view and trace. A row holds what `McpCallMeta` holds, and nothing the agent or the server said: the server
// (its id, which is NOT a foreign key because a server may be removed while the run's record stays, and its name as it was at the call), the
// JSON-RPC method, the cleaned name of a tool, the status the agent's side got, the outcome (`ok`, `cancelled` or a stable code), the duration and
// the sizes. No argument, answer, header or address.
//
// `seq` is the order the rows were written in (a Postgres identity, like `billing_journal_entries`); the live view reads after a `seq`. The row
// names its job with a composite key `(job_id, workspace_id)` to `jobs`, the same as the steps of a turn, so a job's record cannot name another
// workspace. The repository keeps at most 2000 rows for a job (`job-mcp-calls-repository.ts`).
//
// Expand only, safe for the version that is still running (it never reads or writes the table) and for the live database: one new table and one
// index; no column, row or index of an existing table changes. The table is created without its links, and the links are added last (the
// short lock on `jobs` and `workspaces` at the end, on an empty table). The wait is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole
// batch is rolled back (`MIGRATION_FAILED`) and the deployment can be run again. `down` drops the table.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** How long the migration waits for a lock before it gives up. */
export const LOCK_TIMEOUT = "5s";

export const migration: Migration = {
  async up(db) {
    // `set local` ends with the transaction, but the migrations after this one in the same batch run in it too: put back what was set.
    const { rows } = await sql<{
      value: string;
    }>`select current_setting('lock_timeout') as value`.execute(db);
    const before = rows[0]?.value ?? "0";
    await sql`set local lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(db);

    await db.schema
      .createTable("job_mcp_calls")
      .addColumn("seq", "bigint", (column) =>
        column.primaryKey().generatedAlwaysAsIdentity(),
      )
      .addColumn("job_id", "text", (column) => column.notNull())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("server_id", "text", (column) => column.notNull())
      .addColumn("server_name", "text", (column) => column.notNull())
      .addColumn("rpc_method", "text")
      .addColumn("tool", "text")
      .addColumn("status", "integer", (column) => column.notNull())
      .addColumn("outcome", "text", (column) => column.notNull())
      .addColumn("duration_ms", "integer", (column) => column.notNull())
      .addColumn("request_bytes", "integer", (column) => column.notNull())
      .addColumn("response_bytes", "integer", (column) => column.notNull())
      // How many further refusals of the same kind were counted on this row instead of getting a row of their own (the route's "too many calls at
      // once" refusal, which is not bounded by the claim's call count); 0 for every other row.
      .addColumn("suppressed", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "job_mcp_calls_status_check",
        sql`status between 100 and 599`,
      )
      .addCheckConstraint(
        "job_mcp_calls_outcome_check",
        sql`outcome ~ '^[a-z][a-z0-9_]{0,63}$'`,
      )
      .addCheckConstraint(
        "job_mcp_calls_numbers_check",
        sql`duration_ms >= 0 and request_bytes >= 0 and response_bytes >= 0 and suppressed >= 0`,
      )
      .addCheckConstraint(
        "job_mcp_calls_texts_check",
        sql`char_length(server_name) <= 200 and (rpc_method is null or char_length(rpc_method) <= 100) and (tool is null or char_length(tool) <= 100)`,
      )
      .execute();

    // Reading the calls of a job after a `seq` (the page asks for what is new since its last answer), and counting them for the cap.
    await db.schema
      .createIndex("job_mcp_calls_job_seq_index")
      .on("job_mcp_calls")
      .columns(["job_id", "seq"])
      .execute();

    // The row's link to its job, last because it needs the lock on `jobs`. The table is empty.
    await db.schema
      .alterTable("job_mcp_calls")
      .addForeignKeyConstraint(
        "job_mcp_calls_job_fk",
        ["job_id", "workspace_id"],
        "jobs",
        ["id", "workspace_id"],
      )
      .execute();

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("job_mcp_calls").execute();
  },
};
