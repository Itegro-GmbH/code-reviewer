// SPDX-License-Identifier: LicenseRef-Proprietary

// The MCP servers of one running job and the call of the agent for one of them (#1053, epic #1049). Two questions, one answer each:
//
// - `serversOf(job)`: which servers may the agent of this job use? The agent step that started the job names them (`effectiveMcpServers`: the
//   lane's list narrowed by the step) in the lane version the RUN is pinned to, so a retry or a re-run of an old version sees what that version
//   said. Each id is looked up in the job's own workspace (the repository is made for it): an id the workspace does not hold, because the
//   server was removed since, or never was, or is another workspace's, is not an error and not a lookup elsewhere: it is `unavailable`, counted,
//   and the step runs without it.
// - `handle(job, serverId, request)`: the call of the agent. The server must be one of `serversOf(job)` AT THE TIME OF THE CALL (a server removed
//   mid-run answers `mcp_server_unavailable`; so does one the step may not use, and one that does not exist: one answer for all three, so it
//   tells nothing). The credential is read and opened here, for this call, and handed to the proxy; nothing of it is kept.
import type { McpServersRepository } from "../db/repositories/mcp-servers-repository.ts";
import type { WorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import type { WorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { effectiveMcpServers } from "../workflows/mcp.ts";
import type { McpCredentials } from "./credentials.ts";
import type { McpProxy, McpProxyRequest } from "./proxy.ts";
import type { StoredMcpServer } from "../db/repositories/mcp-servers-repository.ts";

/** The part of a job this module reads: its id and the workspace it belongs to. */
export type McpJob = { id: string; workspaceId: string };

export type JobMcpDeps = {
  workflowRuns: Pick<WorkflowRunsRepository, "findStepByJob" | "getRun">;
  workflows: Pick<WorkflowsRepository, "getVersion">;
  /** Scoped to the job's workspace. */
  mcpServers: Pick<McpServersRepository, "list" | "readHeaders">;
  credentials: McpCredentials;
  proxy: McpProxy;
};

export type JobMcpServers = {
  servers: StoredMcpServer[];
  /** How many servers the lane named that the workspace does not have (any more). */
  unavailable: number;
};

export type JobMcp = {
  serversOf(job: McpJob): Promise<JobMcpServers>;
  handle(
    job: McpJob,
    serverId: string,
    request: McpProxyRequest,
  ): Promise<Response>;
};

const NONE: JobMcpServers = { servers: [], unavailable: 0 };

function refusal(code: string, status: number): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: code },
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
}

export function createJobMcp(deps: JobMcpDeps): JobMcp {
  async function serversOf(job: McpJob): Promise<JobMcpServers> {
    const step = await deps.workflowRuns.findStepByJob(job.id);
    if (step === undefined) return NONE;
    const run = await deps.workflowRuns.getRun(step.runId);
    if (run === undefined) return NONE;
    const version = await deps.workflows.getVersion(
      run.workflowId,
      run.workflowVersion,
    );
    if (version === undefined) return NONE;
    let document: unknown;
    try {
      document = JSON.parse(version.document);
    } catch {
      return NONE;
    }
    const ids = effectiveMcpServers(document, step.stepId);
    if (ids.length === 0) return NONE;
    const known = new Map(
      (await deps.mcpServers.list()).map((server) => [server.id, server]),
    );
    const servers: StoredMcpServer[] = [];
    for (const id of ids) {
      const server = known.get(id);
      if (server !== undefined) servers.push(server);
    }
    return { servers, unavailable: ids.length - servers.length };
  }

  return {
    serversOf,

    async handle(job, serverId, request) {
      const { servers } = await serversOf(job);
      if (!servers.some((server) => server.id === serverId))
        return refusal("mcp_server_unavailable", 404);
      const stored = await deps.mcpServers.readHeaders(serverId);
      if (stored === undefined) return refusal("mcp_server_unavailable", 404);
      const credential = await deps.credentials.headersFor(stored);
      if (!credential.ok) return refusal(credential.code, 503);
      return deps.proxy.forward({
        jobId: job.id,
        server: stored.server,
        headers: credential.headers,
        request,
      });
    },
  };
}
