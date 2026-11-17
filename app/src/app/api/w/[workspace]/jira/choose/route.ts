// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/jira/choose { cloudId }: connects one site of the grant the person just made, when it covers several (an Owner
// or Admin, the person who made the grant). Only in a deployment with the capability `implementer`. The logic is in src/jira/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { getJiraRouteHandlers } from "@/jira/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/jira/choose">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_connections", (access) =>
    getJiraRouteHandlers().choose(request, access),
  );
}
