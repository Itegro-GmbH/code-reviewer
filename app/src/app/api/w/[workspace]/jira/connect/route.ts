// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/jira/connect {} or { connectionId }: starts "Connect Jira" (an Owner or Admin) and answers the address of
// Atlassian's consent page, with the signed state of the round trip; `connectionId` connects that connection again. Protected like every
// workspace route (src/workspaces/access-runtime.ts); limited per person and for the instance. Only in a deployment with the capability
// `implementer`. The logic is in src/jira/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { getJiraRouteHandlers } from "@/jira/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/jira/connect">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_connections", (access) =>
    getJiraRouteHandlers().connect(request, access),
  );
}
