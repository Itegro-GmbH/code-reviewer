// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/ai-apps/:grantId/revoke: ends the connection of an AI app (#1144) and goes back to the list. An Owner or Admin may
// revoke any, a Member their own. Only in a deployment with the capability `implementer`.
import { connection } from "next/server";
import { getConnectedAppsHandlers } from "@/factory-mcp/shared";
import { requireImplementerCapability } from "@/implementer/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/ai-apps/[grantId]/revoke">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, grantId } = await context.params;
  return withWorkspace(workspace, "view", (access) =>
    getConnectedAppsHandlers().revoke(request, access, grantId),
  );
}
