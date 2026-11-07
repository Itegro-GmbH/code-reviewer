// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/repositories/:repositoryId/issues?state=open: the tickets (issues and pull requests) of a project's repository from
// the ticket mirror, as GitHub delivers them, plus `lane` (the run that is going on for the ticket) and `costUsd` (what its runs spent).
// Every member may read them. Protected like every workspace route (src/workspaces/access-runtime.ts). The logic is in
// src/tracker/http.ts. Once projects are the ticket source (#922), `/projects/:id/issues` is a thin alias of this route.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createTrackerRouteHandlers } from "@/tracker/http";
import { trackerServiceFor } from "@/tracker/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/repositories/[repositoryId]/issues">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace, repositoryId } = await context.params;
  return withWorkspace(workspace, "view", (access) =>
    createTrackerRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: trackerServiceFor(access.workspace.id),
    }).list(request, repositoryId),
  );
}
