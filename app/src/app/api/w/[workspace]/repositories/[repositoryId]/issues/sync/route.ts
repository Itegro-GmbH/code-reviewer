// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/repositories/:repositoryId/issues/sync: the full sync of the ticket mirror ("Resync" in the project's setup).
// It continues a sync that stopped early or starts one, reads for about twenty seconds and answers 200 when the cache is complete or 202
// when asking again is needed. Protected like every workspace route (src/workspaces/access-runtime.ts). The logic is in
// src/tracker/http.ts.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createTrackerRouteHandlers } from "@/tracker/http";
import { trackerServiceFor } from "@/tracker/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/repositories/[repositoryId]/issues/sync">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace, repositoryId } = await context.params;
  return withWorkspace(workspace, "change_project_settings", (access) =>
    createTrackerRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: trackerServiceFor(access.workspace.id),
    }).sync(request, repositoryId),
  );
}
