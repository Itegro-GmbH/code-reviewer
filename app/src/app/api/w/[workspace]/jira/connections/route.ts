// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/jira/connections: the Jira connections of the workspace (site, account, status, why a broken one is broken),
// for every member. Never a token. Only in a deployment with the capability `implementer`. The logic is in src/jira/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { getJiraRouteHandlers } from "@/jira/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/jira/connections">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    getJiraRouteHandlers().list(request, access),
  );
}
