// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the record of the MCP calls of the jobs of ONE workspace (#1055, epic #1049; the table `job_mcp_calls`; the factory takes the
// workspace id, see ../workspace-scope.ts). One row for each call the agent made through the proxy of the Worker API (#1053) and for each refusal
// of one: the server (its id and its name as it was), the method, the cleaned name of a tool, the status the agent's side got, the outcome, the
// duration and the sizes. Never an argument, an answer, a header or an address: the type holds no field for them.
//
// A job keeps at most `MAX_MCP_CALLS_RECORDED_PER_JOB` rows, the same number as the calls a claim may make (`MCP_MAX_CALLS_PER_CLAIM`), so a
// runaway agent cannot grow the table without a bound: a call past it is not stored (`capped`). The cap is checked in the one statement that
// inserts, so it needs no lock; calls that arrive at the same instant (the route lets four of a job be in flight on one instance) may overshoot by
// the few that were counted at the same time, which is a bound and not an exact number. A job of another workspace (or one that does not exist) is
// not stored for (`unknown_job`): the insert names the workspace and the job together.
import "server-only";
import { sql, type Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

/** The rows a job keeps: the calls one claim may make (`MCP_MAX_CALLS_PER_CLAIM`, src/mcp/in-flight.ts), also across claims of the same job. */
export const MAX_MCP_CALLS_RECORDED_PER_JOB = 2000;

/**
 * One row more than the cap is kept for the refusal that says the claim's limit was reached (`mcp_call_limit_reached`, once: the next one finds the
 * cap), so a run that used all its calls still shows why the next one was refused.
 */
const LIMIT_REFUSAL = "mcp_call_limit_reached";

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
  /** The order the rows were written in; the cursor of the live view. */
  seq: number;
  /** ISO 8601 in UTC. */
  createdAt: string;
};

export type RecordMcpCallResult = "stored" | "capped" | "unknown_job";

export type JobMcpCallsRepository = {
  /** Stores one call of the job `jobId`, unless the job is not this workspace's or already holds the most. */
  record(jobId: string, call: McpCallRecord): Promise<RecordMcpCallResult>;
  /** The calls of the job after the cursor `afterSeq`, oldest first, at most `limit`. */
  listAfter(
    jobId: string,
    afterSeq: number,
    limit: number,
  ): Promise<StoredMcpCall[]>;
  /** How many calls the job holds. */
  count(jobId: string): Promise<number>;
};

export function createJobMcpCallsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): JobMcpCallsRepository {
  return {
    async record(jobId, call) {
      const result = await sql`insert into job_mcp_calls
          (job_id, workspace_id, server_id, server_name, rpc_method, tool, status, outcome, duration_ms, request_bytes, response_bytes, created_at)
        select ${jobId}, ${workspaceId}, ${call.serverId}, ${call.serverName}, ${call.rpcMethod}, ${call.tool}, ${call.status}, ${call.outcome},
          ${call.durationMs}, ${call.requestBytes}, ${call.responseBytes}, ${formatTimestamp(now())}
        where exists (select 1 from jobs where id = ${jobId} and workspace_id = ${workspaceId})
          and (select count(*) from job_mcp_calls where job_id = ${jobId} and workspace_id = ${workspaceId}) < ${
            call.outcome === LIMIT_REFUSAL
              ? MAX_MCP_CALLS_RECORDED_PER_JOB + 1
              : MAX_MCP_CALLS_RECORDED_PER_JOB
          }`.execute(
        db,
      );
      if (Number(result.numAffectedRows ?? 0n) > 0) return "stored";
      const job = await db
        .selectFrom("jobs")
        .select("id")
        .where("id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      return job === undefined ? "unknown_job" : "capped";
    },

    async listAfter(jobId, afterSeq, limit) {
      const rows = await db
        .selectFrom("job_mcp_calls")
        .selectAll()
        .where("job_id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .where("seq", ">", afterSeq)
        .orderBy("seq")
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        // `bigint` reaches us as text from the driver.
        seq: Number(row.seq),
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

    async count(jobId) {
      const row = await db
        .selectFrom("job_mcp_calls")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("job_id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
  };
}
