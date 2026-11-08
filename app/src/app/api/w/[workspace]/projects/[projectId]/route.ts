// SPDX-License-Identifier: LicenseRef-Proprietary

// PUT /api/w/:workspace/projects/:projectId (#937): sets, changes or clears the board of a project's ticket source: `{ "board": { "projectV2Id" } | null }`.
// The board is checked against the boards of the project's repository (GitHub is asked), and the Status field is taken from them. Only the board:
// the repository of a project never changes, and switching it on or off stays `PUT .../repositories/:repositoryId/project`. Admins and Owners
// (`manage_projects`, like creating a project and listing its boards: a Member would learn the board ids from the `available` of an error) may set
// the board, and only in a deployment with the capability `implementer`.
// The logic is in src/projects/create-http.ts.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createNewProjectHandlers } from "@/projects/create-http";
import { boardsFor } from "@/projects/create-shared";
import { projectServiceFor } from "@/projects/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function PUT(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/projects/[projectId]">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace, projectId } = await context.params;
  return withWorkspace(workspace, "manage_projects", (access) =>
    createNewProjectHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: projectServiceFor(access.workspace.id),
      boards: boardsFor(access.workspace.id),
      // Not a new project: no lane is copied.
      laneKeys: [],
      copyLanes: () => Promise.resolve([]),
    }).setBoard(request, projectId),
  );
}
