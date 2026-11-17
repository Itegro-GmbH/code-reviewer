// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/runs/:id/mcp-calls?after=<seq>&limit=<n>: what the agent of a run of the Implementer did with MCP tools, the calls after
// the cursor (#1055, epic #1049). Protected like the run: the workspace is the one in the address, for a member only, and the run is looked up
// in that workspace. The logic is in src/runs/http.ts and src/runs/mcp-calls-service.ts. Metadata only: no argument and no answer is stored.
import { connection } from "next/server";
import { createRunMcpCallsRouteHandlers } from "@/runs/http";
import { runMcpCallsServiceFor } from "@/runs/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/runs/[id]/mcp-calls">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, id } = await context.params;
  return withWorkspace(workspace, "view", (access) =>
    createRunMcpCallsRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: runMcpCallsServiceFor(access.workspace.id),
    }).mcpCalls(request, id),
  );
}
