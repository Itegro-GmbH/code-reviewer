// SPDX-License-Identifier: LicenseRef-Proprietary

// Where the MCP calls of a run are written down for its live view and trace (#1055, epic #1049). The proxy reports each call it made with its
// metadata (`onCall`); a refusal before the proxy arrives as a record (`recordCall`, `job-proxy.ts`). Both end in the job's record
// (`job-mcp-calls-repository.ts`) AFTER the answer went to the agent (`later`: Next's `after()` in the app), so the agent never waits for the
// database, and a database that fails costs the trace of that call and nothing else: one line with the job, never the error text (it may hold
// an address of the database).
import type {
  JobMcpCallsRepository,
  McpCallRecord,
} from "../db/repositories/job-mcp-calls-repository.ts";
import { recordOfMeta } from "./call-record.ts";
import type { McpCallMeta } from "./proxy.ts";

export type CallTrace = {
  /** The proxy's `onCall`: a call that reached the server's address or failed on its way. */
  onCall(meta: McpCallMeta): void;
  /** A refusal before the proxy. */
  recordCall(jobId: string, record: McpCallRecord): void;
};

export function createCallTrace(deps: {
  repository: Pick<JobMcpCallsRepository, "record">;
  /** Runs the work after the response was sent; never rejects. */
  later: (work: () => Promise<void>) => void;
  log: (line: string) => void;
}): CallTrace {
  function recordCall(jobId: string, record: McpCallRecord): void {
    deps.later(async () => {
      try {
        await deps.repository.record(jobId, record);
      } catch {
        deps.log(`[mcp-proxy] job=${jobId} the call could not be recorded`);
      }
    });
  }
  return {
    recordCall,
    onCall(meta) {
      if (meta.jobId === null) return;
      recordCall(meta.jobId, recordOfMeta(meta));
    },
  };
}
