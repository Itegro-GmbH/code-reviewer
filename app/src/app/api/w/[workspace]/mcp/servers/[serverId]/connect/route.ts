// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/mcp/servers/:serverId/connect: starts "Connect" of an MCP server that uses OAuth (an Owner or Admin) and answers the
// address of the authorization server's consent page, with the signed state of the round trip. Protected like every workspace route
// (src/workspaces/access-runtime.ts); limited per person and for the instance. Only in a deployment with the capability `implementer`. The logic
// is in src/mcp/oauth/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { getMcpOAuthRouteHandlers } from "@/mcp/oauth/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/mcp/servers/[serverId]/connect">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  requireImplementerCapability();
  const { workspace, serverId } = await context.params;
  return withWorkspace(workspace, "manage_mcp", (access) =>
    getMcpOAuthRouteHandlers().connect(request, access, serverId),
  );
}
