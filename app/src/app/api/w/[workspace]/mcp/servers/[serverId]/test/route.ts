// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/mcp/servers/:serverId/test: the connection test (an Owner or Admin). This server connects to the address as an MCP
// client (`initialize`, `tools/list`), stores the tool list and answers the server. Rate limited; the address is guarded at the connection.
// Only in a deployment with the capability `implementer`. The logic is in src/mcp/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { getMcpRouteHandlers } from "@/mcp/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/mcp/servers/[serverId]/test">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, serverId } = await context.params;
  return withWorkspace(workspace, "manage_mcp", (access) =>
    getMcpRouteHandlers().test(request, access, serverId),
  );
}
