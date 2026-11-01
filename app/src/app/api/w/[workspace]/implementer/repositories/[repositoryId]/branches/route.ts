// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/implementer/repositories/:repositoryId/branches (#755): the default branch and the first hundred branches
// of a repository of the workspace, for the base branch picker. Only in a deployment with the capability `implementer`. The
// logic is in src/implementer/http.ts.
import { connection } from "next/server";
import { createImplementerRouteHandlers } from "@/implementer/http";
import {
  implementerServiceFor,
  requireImplementerCapability,
} from "@/implementer/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/implementer/repositories/[repositoryId]/branches">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace, repositoryId } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createImplementerRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: implementerServiceFor(access.workspace.id),
    }).branches(request, repositoryId),
  );
}
