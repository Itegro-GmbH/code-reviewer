// SPDX-License-Identifier: LicenseRef-Proprietary

// The MCP calls of a run of the Implementer for the Runs page (#1055, epic #1049): what the agent did with MCP tools, as the proxy of the Worker
// API wrote it down while the turn ran (`job_mcp_calls`). A thin layer over the record of ONE workspace (`job-mcp-calls-repository.ts`) that
// checks what comes in from the URL and turns the rows into the views the browser may see (`mcp-calls-view.ts`).
//
// Only a run of the Implementer has calls (a lane's agent step runs as one). The id of a run of another kind, of another workspace or of nothing
// is the same answer: `undefined`, which the route turns into 404 `RUN_NOT_FOUND`. A run without calls answers an empty page.
import "server-only";
import {
  MAX_MCP_CALLS_RECORDED_PER_JOB,
  type JobMcpCallsRepository,
} from "../db/repositories/job-mcp-calls-repository.ts";
import type { RunsRepository } from "../db/repositories/runs-repository.ts";
import {
  classifyOutcome,
  type McpCallView,
  type McpCallsSnapshot,
} from "./mcp-calls-view.ts";

const RUN_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type RunMcpCallsService = {
  /** The calls of the run after `after`; undefined for an id that is not a run of the Implementer of this workspace. */
  list(
    id: string,
    after: number,
    limit: number,
  ): Promise<McpCallsSnapshot | undefined>;
};

export function createRunMcpCallsService(deps: {
  runs: Pick<RunsRepository, "implementerRun">;
  calls: Pick<JobMcpCallsRepository, "listAfter" | "count">;
  /** Takes secrets out of a text before it is shown (the names come from an agent and a person). */
  redact?: (text: string) => string;
}): RunMcpCallsService {
  const redact = deps.redact ?? ((text: string) => text);
  return {
    async list(id, after, limit) {
      if (!RUN_ID.test(id)) return undefined;
      if ((await deps.runs.implementerRun(id)) === undefined) return undefined;
      // One more than asked for tells whether there is more behind the answer.
      const rows = await deps.calls.listAfter(id, after, limit + 1);
      const page = rows.slice(0, limit);
      const calls: McpCallView[] = page.map((row) => ({
        seq: row.seq,
        serverId: row.serverId,
        serverName: redact(row.serverName),
        rpcMethod: row.rpcMethod === null ? null : redact(row.rpcMethod),
        tool: row.tool === null ? null : redact(row.tool),
        status: row.status,
        ...classifyOutcome(row.outcome),
        durationMs: row.durationMs,
        requestBytes: row.requestBytes,
        responseBytes: row.responseBytes,
        at: row.createdAt,
      }));
      const hasMore = rows.length > limit;
      // Asked only at the end of the list: a page that has more behind it does not need to know.
      const full =
        !hasMore &&
        (await deps.calls.count(id)) >= MAX_MCP_CALLS_RECORDED_PER_JOB;
      return { calls, cursor: page.at(-1)?.seq ?? after, hasMore, full };
    },
  };
}
