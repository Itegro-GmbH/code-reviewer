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
  MCP_CALLS_OVERLAP_ROWS,
  MCP_CALLS_PAGE_LIMIT,
  type McpCallView,
  type McpCallsSnapshot,
} from "./mcp-calls-view.ts";

const RUN_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const COUNT = /^\d{1,16}$/;

/** What a request may ask for (as `StepsQueryInput`). */
export type McpCallsQueryInput = {
  after?: string | null | undefined;
  limit?: string | null | undefined;
};

export type ParsedMcpCallsQuery =
  { ok: true; after: number; limit: number } | { ok: false };

/**
 * The query of the route: `after` is the cursor of the last answer (0 for the first request), `limit` how many calls one answer holds at most
 * (1 to 200; a larger number is read as 200). The cursor is a `seq` of `job_mcp_calls`, which is a table-wide identity (`bigint`) and not a
 * counter of one run like the steps', so it is NOT held to the 32 bits of `parseStepsQuery`: it may be any number a JavaScript number holds
 * exactly. A number past that is refused (the repository refuses to hand one out either, `McpSeqOutOfRangeError`).
 */
export function parseMcpCallsQuery(
  input: McpCallsQueryInput,
): ParsedMcpCallsQuery {
  const after = input.after ?? "0";
  const limit = input.limit ?? String(MCP_CALLS_PAGE_LIMIT);
  if (!COUNT.test(after) || !COUNT.test(limit)) return { ok: false };
  const afterSeq = Number(after);
  const count = Number(limit);
  if (!Number.isSafeInteger(afterSeq) || count < 1) return { ok: false };
  return {
    ok: true,
    after: afterSeq,
    limit: Math.min(count, MCP_CALLS_PAGE_LIMIT),
  };
}

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
  calls: Pick<JobMcpCallsRepository, "listAfter" | "summary">;
  /** Takes secrets out of a text before it is shown (the names come from an agent and a person). */
  redact?: (text: string) => string;
}): RunMcpCallsService {
  const redact = deps.redact ?? ((text: string) => text);
  return {
    async list(id, after, limit) {
      if (!RUN_ID.test(id)) return undefined;
      if ((await deps.runs.implementerRun(id)) === undefined) return undefined;
      // The page starts a few rows behind the cursor (a row that became visible late), and holds `limit` rows after it: the overlap is on top of
      // the limit, so a small limit still moves the cursor. One more tells whether there is more behind the answer.
      const rows = await deps.calls.listAfter(
        id,
        after,
        limit + MCP_CALLS_OVERLAP_ROWS + 1,
        MCP_CALLS_OVERLAP_ROWS,
      );
      const behind = rows.filter((row) => row.seq <= after);
      const fresh = rows.filter((row) => row.seq > after);
      const page = [...behind, ...fresh.slice(0, limit)];
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
      const hasMore = fresh.length > limit;
      // Asked only at the end of the list, and not for a run that has no call at all (a lane without MCP): nothing was written for it, so there is
      // nothing to count either.
      const noCalls = after === 0 && rows.length === 0;
      const summary =
        hasMore || noCalls ? undefined : await deps.calls.summary(id);
      return {
        calls,
        // Never back: the page read behind the cursor, the cursor itself only moves on.
        cursor: Math.max(after, page.at(-1)?.seq ?? 0),
        hasMore,
        full: (summary?.rows ?? 0) >= MAX_MCP_CALLS_RECORDED_PER_JOB,
        omitted: summary?.suppressed ?? 0,
      };
    },
  };
}
