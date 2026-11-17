// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/mcp/servers: the MCP servers of the workspace (name, address, transport, the NAMES of the headers, the last test and
// its tool list), for every member; never a header value. POST adds a server (an Owner or Admin). Only in a deployment with the capability
// `implementer`. The logic is in src/mcp/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { getMcpRouteHandlers } from "@/mcp/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/mcp/servers">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "view", (access) =>
    getMcpRouteHandlers().list(request, access),
  );
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/mcp/servers">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_mcp", (access) =>
    getMcpRouteHandlers().create(request, access),
  );
}
