// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/implementer/repositories (#755): the active repositories of the workspace with the write permission of
// their installation, for the repository picker of the form that sends a task to the Implementer. The routes exist only in a
// deployment with the capability `implementer`; elsewhere the proxy answers them as a path that does not exist
// (src/capabilities/). Protected like every workspace route (src/workspaces/access-runtime.ts). The logic is in
// src/implementer/http.ts.
import { connection } from "next/server";
import { createImplementerRouteHandlers } from "@/implementer/http";
import {
  implementerServiceFor,
  requireImplementerCapability,
} from "@/implementer/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/implementer/repositories">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createImplementerRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: implementerServiceFor(access.workspace.id),
    }).repositories(request),
  );
}
