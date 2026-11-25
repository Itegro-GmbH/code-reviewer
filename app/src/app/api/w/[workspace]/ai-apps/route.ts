// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/ai-apps: the AI apps connected to the factory MCP in this workspace (#1144): an Owner or Admin sees all, a Member their
// own. Only in a deployment with the capability `implementer`.
import { connection } from "next/server";
import { getConnectedAppsHandlers } from "@/factory-mcp/shared";
import { requireImplementerCapability } from "@/implementer/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/w/[workspace]/ai-apps">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "view", (access) =>
    getConnectedAppsHandlers().list(access),
  );
}
