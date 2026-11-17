// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the record of the MCP calls of the jobs of ONE workspace (#1055, epic #1049; the table `job_mcp_calls`; the factory takes the
// workspace id, see ../workspace-scope.ts). One row for each call the agent made through the proxy of the Worker API (#1053) and for each refusal
// of one: the server (its id and its name as it was), the method, the cleaned name of a tool, the status the agent's side got, the outcome, the
// duration and the sizes. Never an argument, an answer, a header or an address: the type holds no field for them.
//
// A job keeps at most `MAX_MCP_CALLS_RECORDED_PER_JOB` rows, the same number as the calls a claim may make (`MCP_MAX_CALLS_PER_CLAIM`), so a
// runaway agent cannot grow the table without a bound: a call past it is not stored (`capped`). The cap is checked in the one statement that
// inserts, so it needs no lock, and it is a bound, not an exact number: calls whose statements run at the same moment count the same rows and
// may overshoot by the few that were in flight. How many that can be: the route lets four calls of a job be in flight on ONE instance (the place
// is given back when the answer has ended, `in-flight.ts`), and every instance has its own four, so the overshoot is a handful, never a growth.
//
// The refusal "too many calls at once" (`mcp_too_many_concurrent_calls`) is the one the claim's call count does not bound (it comes before the
// count), and a looping agent can make thousands of them. So only the first `MAX_GATE_REFUSALS_STORED` of a job get a row; every later one is
// counted on the newest of them (`suppressed`) in the same single statement, and the real calls keep their share of the 2000 rows.
//
// The cursor of the live view is `seq`, a Postgres identity: it is handed out when the insert runs and the row is visible when its transaction
// commits, so rows can become visible out of order. A reader therefore reads again from `OVERLAP_ROWS` rows before its cursor (`listAfter`) and
// merges by `seq`. A job of another workspace (or one that does not exist) is not stored for (`unknown_job`): the insert names the workspace and
// the job together.
import "server-only";
import { sql, type Kysely } from "kysely";
import { MAX_MCP_CALLS_RECORDED_PER_JOB } from "../mcp-call-limits.ts";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export { MAX_MCP_CALLS_RECORDED_PER_JOB };

/**
 * One row more than the cap is kept for the refusal that says the claim's limit was reached (`mcp_call_limit_reached`, once: the next one finds the
 * cap), so a run that used all its calls still shows why the next one was refused.
 */
const LIMIT_REFUSAL = "mcp_call_limit_reached";

/** The refusal of the route that the claim's call count does not bound: only the first few of a job are stored, the rest is counted. */
const GATE_REFUSAL = "mcp_too_many_concurrent_calls";
export const MAX_GATE_REFUSALS_STORED = 20;

/** `seq` is a table-wide identity (`bigint`); a number of the page is exact up to 2^53, and past it the code refuses to go on instead of misordering. */
export class McpSeqOutOfRangeError extends Error {
  constructor() {
    super("job_mcp_calls.seq is beyond the range a number holds exactly");
    this.name = "McpSeqOutOfRangeError";
  }
}

function seqOf(value: string | number): number {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq)) throw new McpSeqOutOfRangeError();
  return seq;
}

/** What is recorded of one call. The texts are cleaned and cut by the caller (`src/mcp/call-record.ts`); the table checks their length. */
export type McpCallRecord = {
  serverId: string;
  /** The name of the server as it was when the call was made. */
  serverName: string;
  /** The JSON-RPC method (`tools/call`, `tools/list`, …); null for a DELETE or a refusal before the message was read. */
  rpcMethod: string | null;
  /** The name of the tool of a `tools/call`; null otherwise. */
  tool: string | null;
  /** The status the agent's side got. */
  status: number;
  /** `ok`, `cancelled`, or a stable code (`src/mcp/refusal.ts`, `src/mcp/proxy.ts`). */
  outcome: string;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
};

export type StoredMcpCall = McpCallRecord & {
  /** Refusals of the same kind that were counted on this row instead of stored (see the header); 0 for nearly every row. */
  suppressed: number;
  /** The order the rows were written in; the cursor of the live view. */
  seq: number;
  /** ISO 8601 in UTC. */
  createdAt: string;
};

export type RecordMcpCallResult =
  | "stored"
  /** A refusal past the first few of its kind: counted on the newest of them, no row of its own. */
  | "counted"
  | "capped"
  | "unknown_job";

export type JobMcpCallsRepository = {
  /** Stores one call of the job `jobId`, unless the job is not this workspace's or already holds the most. */
  record(jobId: string, call: McpCallRecord): Promise<RecordMcpCallResult>;
  /**
   * The calls of the job after the cursor `afterSeq`, oldest first, at most `limit`. With `overlapRows` the answer starts that many of the job's
   * rows BEFORE the cursor, so a row that became visible after the cursor had passed it is read once more (the caller merges by `seq`).
   */
  listAfter(
    jobId: string,
    afterSeq: number,
    limit: number,
    overlapRows?: number,
  ): Promise<StoredMcpCall[]>;
  /** How many rows the job holds, and how many refusals were counted instead of stored. */
  summary(jobId: string): Promise<{ rows: number; suppressed: number }>;
};

export function createJobMcpCallsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): JobMcpCallsRepository {
  async function jobExists(jobId: string): Promise<boolean> {
    const job = await db
      .selectFrom("jobs")
      .select("id")
      .where("id", "=", jobId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return job !== undefined;
  }

  /**
   * One statement for both outcomes: the first `MAX_GATE_REFUSALS_STORED` refusals of a job insert a row (when the job's rows are not at the cap),
   * every later one adds 1 to `suppressed` of the newest of them. Only when it did neither is the job looked up, to tell `capped` from `unknown_job`.
   */
  async function recordGateRefusal(
    jobId: string,
    call: McpCallRecord,
  ): Promise<RecordMcpCallResult> {
    const result = await sql<{ inserted: number; counted: number }>`
      with held as (
        select count(*)::int as n from job_mcp_calls
        where job_id = ${jobId} and workspace_id = ${workspaceId} and outcome = ${GATE_REFUSAL}
      ),
      inserted as (
        insert into job_mcp_calls
          (job_id, workspace_id, server_id, server_name, rpc_method, tool, status, outcome, duration_ms, request_bytes, response_bytes, created_at)
        select ${jobId}, ${workspaceId}, ${call.serverId}, ${call.serverName}, ${call.rpcMethod}, ${call.tool}, ${call.status}, ${call.outcome},
          ${call.durationMs}, ${call.requestBytes}, ${call.responseBytes}, ${formatTimestamp(now())}
        where exists (select 1 from jobs where id = ${jobId} and workspace_id = ${workspaceId})
          and (select n from held) < ${MAX_GATE_REFUSALS_STORED}
          and (select count(*) from job_mcp_calls where job_id = ${jobId} and workspace_id = ${workspaceId}) < ${MAX_MCP_CALLS_RECORDED_PER_JOB}
        returning seq
      ),
      counted as (
        update job_mcp_calls set suppressed = suppressed + 1
        where seq = (
          select max(seq) from job_mcp_calls
          where job_id = ${jobId} and workspace_id = ${workspaceId} and outcome = ${GATE_REFUSAL}
        ) and (select n from held) >= ${MAX_GATE_REFUSALS_STORED}
        returning seq
      )
      select (select count(*) from inserted)::int as inserted, (select count(*) from counted)::int as counted`.execute(
      db,
    );
    const row = result.rows[0];
    if ((row?.inserted ?? 0) > 0) return "stored";
    if ((row?.counted ?? 0) > 0) return "counted";
    return (await jobExists(jobId)) ? "capped" : "unknown_job";
  }

  return {
    async record(jobId, call) {
      if (call.outcome === GATE_REFUSAL) return recordGateRefusal(jobId, call);
      const result = await sql`insert into job_mcp_calls
          (job_id, workspace_id, server_id, server_name, rpc_method, tool, status, outcome, duration_ms, request_bytes, response_bytes, created_at)
        select ${jobId}, ${workspaceId}, ${call.serverId}, ${call.serverName}, ${call.rpcMethod}, ${call.tool}, ${call.status}, ${call.outcome},
          ${call.durationMs}, ${call.requestBytes}, ${call.responseBytes}, ${formatTimestamp(now())}
        where exists (select 1 from jobs where id = ${jobId} and workspace_id = ${workspaceId})
          and (select count(*) from job_mcp_calls where job_id = ${jobId} and workspace_id = ${workspaceId}) < ${
            call.outcome === LIMIT_REFUSAL
              ? MAX_MCP_CALLS_RECORDED_PER_JOB + 1
              : MAX_MCP_CALLS_RECORDED_PER_JOB
          }`.execute(db);
      if (Number(result.numAffectedRows ?? 0) > 0) return "stored";
      return (await jobExists(jobId)) ? "capped" : "unknown_job";
    },

    async listAfter(jobId, afterSeq, limit, overlapRows = 0) {
      // The lower bound: the `seq` of the `overlapRows`-th row of this job at or before the cursor (or the cursor itself where there are fewer).
      const from =
        overlapRows > 0
          ? sql<string>`coalesce((select min(older.seq) - 1 from (
              select seq from job_mcp_calls
              where job_id = ${jobId} and workspace_id = ${workspaceId} and seq <= ${afterSeq}
              order by seq desc limit ${overlapRows}) as older), ${afterSeq})`
          : sql<string>`${afterSeq}`;
      const rows = await db
        .selectFrom("job_mcp_calls")
        .selectAll()
        .where("job_id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .where(sql<boolean>`seq > ${from}`)
        .orderBy("seq")
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        // `bigint` reaches us as text from the driver.
        seq: seqOf(row.seq),
        suppressed: row.suppressed,
        serverId: row.server_id,
        serverName: row.server_name,
        rpcMethod: row.rpc_method,
        tool: row.tool,
        status: row.status,
        outcome: row.outcome,
        durationMs: row.duration_ms,
        requestBytes: row.request_bytes,
        responseBytes: row.response_bytes,
        createdAt: row.created_at,
      }));
    },

    async summary(jobId) {
      const row = await db
        .selectFrom("job_mcp_calls")
        .select((eb) => [
          eb.fn.countAll<string>().as("rows"),
          sql<string>`coalesce(sum(suppressed), 0)`.as("suppressed"),
        ])
        .where("job_id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirstOrThrow();
      return { rows: Number(row.rows), suppressed: Number(row.suppressed) };
    },
  };
}
