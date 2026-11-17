// SPDX-License-Identifier: LicenseRef-Proprietary

// DELETE /api/w/:workspace/jira/connections/:connectionId: removes a Jira connection of the workspace (an Owner or Admin) and forgets
// its tokens. Refused with 409 `jira_connection_in_use`, naming the projects, while a project uses it as its ticket source. Only in a
// deployment with the capability `implementer`. The logic is in src/jira/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { getJiraRouteHandlers } from "@/jira/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/jira/connections/[connectionId]">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  requireImplementerCapability();
  const { workspace, connectionId } = await context.params;
  return withWorkspace(workspace, "manage_connections", (access) =>
    getJiraRouteHandlers().remove(request, access, connectionId),
  );
}
