// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/jira/connections/:connectionId/projects (#1038): the projects of the Jira site of a connection of the workspace
// (key and name), read now with the connection's token, for the "New project" dialog. For the people who create projects
// (`manage_projects`), only in a deployment with the capability `implementer`. A connection of another workspace is a 404, a broken one a
// 409 (a person has to connect it again), a site that cannot be asked a 503. The logic is in src/projects/create-http.ts.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createNewProjectHandlers } from "@/projects/create-http";
import { jiraProjectsFor } from "@/jira/source-shared";
import { projectServiceFor } from "@/projects/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/jira/connections/[connectionId]/projects">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, connectionId } = await context.params;
  return withWorkspace(workspace, "manage_projects", (access) =>
    createNewProjectHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: projectServiceFor(access.workspace.id),
      // Listing projects reads no boards and copies no lane.
      boards: async () => ({ kind: "failed" }),
      jiraProjects: jiraProjectsFor(access.workspace.id),
      laneKeys: [],
      copyLanes: async () => [],
    }).jiraProjects(request, connectionId),
  );
}
