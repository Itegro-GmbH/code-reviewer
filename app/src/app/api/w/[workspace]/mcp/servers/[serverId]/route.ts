// SPDX-License-Identifier: LicenseRef-Proprietary

// PUT /api/w/:workspace/mcp/servers/:serverId changes an MCP server of the workspace (an Owner or Admin; a header may be kept without its
// value); DELETE removes it, refused with 409 `mcp_server_in_use`, naming the lanes, while a lane uses it. Only in a deployment with the
// capability `implementer`. The logic is in src/mcp/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { getMcpRouteHandlers } from "@/mcp/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function PUT(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/mcp/servers/[serverId]">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, serverId } = await context.params;
  return withWorkspace(workspace, "manage_mcp", (access) =>
    getMcpRouteHandlers().update(request, access, serverId),
  );
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/mcp/servers/[serverId]">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, serverId } = await context.params;
  return withWorkspace(workspace, "manage_mcp", (access) =>
    getMcpRouteHandlers().remove(request, access, serverId),
  );
}
