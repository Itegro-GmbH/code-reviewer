// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/repositories/:repositoryId/boards (#922): the boards (GitHub Projects) of a repository that a new project can take as
// its board, with the options of the Status field of each, read from GitHub with a token that may read boards and nothing else. For the
// people who create projects (`manage_projects`), only in a deployment with the capability `implementer`. The logic is in
// src/projects/create-http.ts.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createNewProjectHandlers } from "@/projects/create-http";
import { boardsFor, laneCopierFor } from "@/projects/create-shared";
import { projectServiceFor } from "@/projects/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/repositories/[repositoryId]/boards">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, repositoryId } = await context.params;
  return withWorkspace(workspace, "manage_projects", (access) =>
    createNewProjectHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: projectServiceFor(access.workspace.id),
      boards: boardsFor(access.workspace.id),
      copyLanes: laneCopierFor(access.workspace.id),
    }).boards(request, repositoryId),
  );
}
