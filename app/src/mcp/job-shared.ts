// SPDX-License-Identifier: LicenseRef-Proprietary

// The MCP runtime of a job on the running server (#1053): the real database, the master key, the test flag and the guarded fetch. Server code
// only; the claim (`runner-api/claim.ts`) and the Worker API's MCP route (`runner-api/worker-api.ts`) call it through `jobMcp` of their deps.
import "server-only";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { createJobMcpCallsRepository } from "../db/repositories/job-mcp-calls-repository.ts";
import { createMcpServersRepository } from "../db/repositories/mcp-servers-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createGuardedFetch } from "../dispatch/guarded-fetch.ts";
import { runAfterResponse } from "../dispatch/shared.ts";
import { mcpTestEndpointsAllowed } from "./config.ts";
import { cleanText } from "./client.ts";
import { createCallTrace } from "./call-trace.ts";
import { createMcpCredentials } from "./credentials.ts";
import { createJobMcp, type JobMcp } from "./job-proxy.ts";
import { createMcpProxy, type McpCallMeta } from "./proxy.ts";

const guardedFetches = new Map<
  boolean,
  ReturnType<typeof createGuardedFetch>
>();

function guardedFetch(allowLoopback: boolean) {
  let guarded = guardedFetches.get(allowLoopback);
  if (guarded === undefined) {
    guarded = createGuardedFetch({ allowLoopback });
    guardedFetches.set(allowLoopback, guarded);
  }
  return guarded;
}

/**
 * One line for each call: the server, the method, the name of a tool, the status, the duration and the sizes. The run's live view and trace
 * read the same `McpCallMeta` (`call-trace.ts`). Never an argument, an answer, a header or an address.
 */
export function logMcpCall(meta: McpCallMeta): void {
  // The method and the tool come from the agent: cleaned once more here, so no line of a log can be forged whoever calls this.
  console.info(
    `[mcp-proxy] job=${meta.jobId ?? "-"} server=${meta.serverId} method=${meta.rpcMethod === null ? "-" : cleanText(meta.rpcMethod).slice(0, 100)} tool=${meta.tool === null ? "-" : cleanText(meta.tool).slice(0, 100)} status=${String(meta.status)} outcome=${meta.outcome} ms=${String(meta.durationMs)} in=${String(meta.requestBytes)} out=${String(meta.responseBytes)}`,
  );
}

/** The MCP runtime of one workspace: its servers, the runs of its lanes, and the proxy with the master key. */
export function jobMcpFor(workspaceId: string): JobMcp {
  const db = getDatabase();
  const resolved = resolveAppSecret(process.env);
  // The server does not start without it (src/auth/startup.ts); this is the second line.
  if (!resolved.ok) throw new Error(resolved.problem);
  const allowTestEndpoints = mcpTestEndpointsAllowed(process.env);
  // #1055: each call and each refusal also goes into the job's record for the run's live view, scoped to the job's own workspace.
  const trace = createCallTrace({
    repository: createJobMcpCallsRepository(db, workspaceId),
    later: runAfterResponse,
    log: (line) => console.info(line),
  });
  return createJobMcp({
    workflowRuns: createWorkflowRunsRepository(db, workspaceId),
    workflows: createWorkflowsRepository(db, workspaceId),
    mcpServers: createMcpServersRepository(db, workspaceId),
    credentials: createMcpCredentials({ appSecret: resolved.secret }),
    log: (line) => console.info(line),
    recordCall: trace.recordCall,
    proxy: createMcpProxy({
      fetch: guardedFetch(allowTestEndpoints),
      allowTestEndpoints,
      onCall: (meta) => {
        logMcpCall(meta);
        trace.onCall(meta);
      },
    }),
  });
}
