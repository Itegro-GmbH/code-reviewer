// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/projects/:projectId/issues?state=open (#922): the tickets of a project, which are the issues of its ticket source:
// the same answer as `GET .../repositories/:repositoryId/issues` (src/app/api/w/[workspace]/repositories/[repositoryId]/issues/route.ts)
// for the repository of the project. A project id the workspace does not have is `TRACKER_PROJECT_NOT_FOUND`. Every member may read them.
import { connection } from "next/server";
import { projectServiceFor } from "@/projects/shared";
import { createTrackerRouteHandlers } from "@/tracker/http";
import { trackerServiceFor } from "@/tracker/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/projects/[projectId]/issues">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, projectId } = await context.params;
  return withWorkspace(workspace, "view", async (access) => {
    const project = await projectServiceFor(access.workspace.id).getProject(
      projectId,
    );
    if (project === undefined)
      return Response.json(
        { error: "TRACKER_PROJECT_NOT_FOUND" },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    return createTrackerRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: trackerServiceFor(access.workspace.id),
    }).list(request, project.ticketSource.repositoryId);
  });
}
