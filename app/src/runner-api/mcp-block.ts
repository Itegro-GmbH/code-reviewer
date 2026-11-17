// SPDX-License-Identifier: LicenseRef-Proprietary

// `implementer.mcp` of a job (#1053, epic #1049): the MCP servers the agent step may use, as the Worker needs to know them to serve a local
// endpoint for each. Resolved when the job is claimed, in the job's own workspace, from the lane version the run is pinned to
// (`mcp/job-proxy.ts`): a server the workspace no longer has is not here, it is counted in `unavailable` (the step runs without it).
//
// By design there is no address, no header and no credential in it: the agent never talks to a server. It talks to the local endpoint at its
// door; the door calls the app (`POST /api/workers/v1/jobs/:id/mcp/:server`, with the credential of the job) and the app adds the credential
// of the server on the way. A turn no workflow step started has no lane and so no servers.
import type { Job } from "../jobs/job-types.ts";
import type { ImplementerMcp } from "../contracts/runner-api.ts";
import type { JobMcp } from "../mcp/job-proxy.ts";
import type { RunnerApiLogger } from "./logger.ts";

export type McpBlockDeps = {
  /** The MCP runtime of one workspace; left out where the deployment has none. */
  jobMcp?: (workspaceId: string) => Pick<JobMcp, "serversOf">;
  logger: RunnerApiLogger;
};

const TRANSPORTS = ["streamable-http", "sse"] as const;

export async function mcpBlockOf(
  deps: McpBlockDeps,
  input: {
    job: Pick<Job, "id" | "workspaceId">;
    features: readonly string[];
    startedByWorkflow: boolean;
  },
): Promise<ImplementerMcp | undefined> {
  const { job, features, startedByWorkflow } = input;
  if (deps.jobMcp === undefined || !startedByWorkflow) return undefined;
  const found = await deps.jobMcp(job.workspaceId).serversOf(job);
  const servers = found.servers.flatMap((server) => {
    const transport = TRANSPORTS.find((entry) => entry === server.transport);
    return transport === undefined
      ? []
      : [{ id: server.id, name: server.name, transport }];
  });
  if (servers.length === 0 && found.unavailable === 0) return undefined;
  // A caller that does not read the field runs the turn without MCP tools: the agent lacks tools, nothing widens, so the turn is not refused.
  if (!features.includes("implementer_mcp")) {
    deps.logger.info(
      `[runner-api] job=${job.id} mcp servers not delivered: the caller did not name implementer_mcp`,
    );
    return undefined;
  }
  return {
    servers,
    ...(found.unavailable === 0
      ? {}
      : { unavailable: Math.min(found.unavailable, 50) }),
  };
}
