// SPDX-License-Identifier: LicenseRef-Proprietary

// The MCP servers of one running job and the call of the agent for one of them (#1053, epic #1049). Two questions, one answer each:
//
// - `serversOf(job)`: which servers may the agent of this job use? The agent step that started the job names them (`effectiveMcpServers`: the
//   lane's list narrowed by the step) in the lane version the RUN is pinned to, so a retry or a re-run of an old version sees what that version
//   said. Each id is looked up in the job's own workspace (the repository is made for it): an id the workspace does not hold, because the
//   server was removed since, or never was, or is another workspace's, is not an error and not a lookup elsewhere: it is `unavailable`, counted,
//   and the step runs without it. One lookup per id of the step (`get`), never a list of all the workspace's servers.
// - `handle(job, serverId, request)`: the call of the agent. The server must be one of `serversOf(job)` AT THE TIME OF THE CALL (a server removed
//   mid-run answers `mcp_server_unavailable`; so does one the step may not use, and one that does not exist: one answer for all three, so it
//   tells nothing). The credential is read and opened here, for this call, and handed to the proxy; nothing of it is kept. A GET is 405 before
//   anything is looked up, and a server the step does not name is refused before the table of servers is read.
//
// A refusal before the proxy is logged with the job, the server id and the code, never a value.
import type { McpServersRepository } from "../db/repositories/mcp-servers-repository.ts";
import type { WorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import type { WorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { effectiveMcpServers } from "../workflows/mcp.ts";
import { mcpRefusal, type McpRouteRefusal } from "./refusal.ts";
import type { McpCredentials } from "./credentials.ts";
import type { McpProxy, McpProxyRequest } from "./proxy.ts";
import type { StoredMcpServer } from "../db/repositories/mcp-servers-repository.ts";

/** The part of a job this module reads: its id and the workspace it belongs to. */
export type McpJob = { id: string; workspaceId: string };

export type JobMcpDeps = {
  workflowRuns: Pick<WorkflowRunsRepository, "findStepByJob" | "getRun">;
  workflows: Pick<WorkflowsRepository, "getVersion">;
  /** Scoped to the job's workspace. */
  mcpServers: Pick<McpServersRepository, "get" | "readHeaders">;
  credentials: McpCredentials;
  proxy: McpProxy;
  /** Where a refusal before the proxy is written (one line, no value). */
  log?: (line: string) => void;
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

/** A server id as text for a log line: only what looks like one (the route checks it; a caller that did not gets a dash). */
const LOGGABLE_ID = /^[0-9a-fA-F-]{36}$/;

export function createJobMcp(deps: JobMcpDeps): JobMcp {
  function refuse(
    job: McpJob,
    serverId: string,
    code: McpRouteRefusal,
  ): Response {
    deps.log?.(
      `[mcp-proxy] job=${job.id} server=${LOGGABLE_ID.test(serverId) ? serverId : "-"} refused: ${code}`,
    );
    return mcpRefusal(code);
  }

  /** The ids of the servers the agent step of the job names (the lane version of its run); none for a job no step started. */
  async function idsOf(job: McpJob): Promise<string[]> {
    const step = await deps.workflowRuns.findStepByJob(job.id);
    if (step === undefined) return [];
    const run = await deps.workflowRuns.getRun(step.runId);
    if (run === undefined) return [];
    const version = await deps.workflows.getVersion(
      run.workflowId,
      run.workflowVersion,
    );
    if (version === undefined) return [];
    let document: unknown;
    try {
      document = JSON.parse(version.document);
    } catch {
      return [];
    }
    return effectiveMcpServers(document, step.stepId);
  }

  async function serversOf(job: McpJob): Promise<JobMcpServers> {
    const ids = await idsOf(job);
    if (ids.length === 0) return NONE;
    const found = await Promise.all(ids.map((id) => deps.mcpServers.get(id)));
    const servers = found.filter(
      (server): server is StoredMcpServer => server !== undefined,
    );
    return { servers, unavailable: ids.length - servers.length };
  }

  return {
    serversOf,

    async handle(job, serverId, request) {
      // The server's own stream is not offered: no lookup, no unsealing.
      if (request.method === "GET")
        return new Response(null, {
          status: 405,
          headers: { allow: "POST, DELETE", "cache-control": "no-store" },
        });
      // The step must name the server, at the time of this call: asked of the lane, before the table of servers is read at all.
      if (!(await idsOf(job)).includes(serverId))
        return refuse(job, serverId, "mcp_server_unavailable");
      // Removed since (or never there, or another workspace's): the scoped repository does not have it.
      const stored = await deps.mcpServers.readHeaders(serverId);
      if (stored === undefined)
        return refuse(job, serverId, "mcp_server_unavailable");
      const credential = await deps.credentials.headersFor(stored);
      if (!credential.ok) return refuse(job, serverId, credential.code);
      return deps.proxy.forward({
        jobId: job.id,
        server: stored.server,
        headers: credential.headers,
        request,
      });
    },
  };
}
