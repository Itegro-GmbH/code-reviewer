// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/projects/:projectId/todos (#924): the ToDos of one project, the same answer as `GET .../todos` narrowed to the
// lanes and the repository of the project. A project id the workspace does not have is `TODOS_PROJECT_NOT_FOUND`. Every member may read
// them. Only in a deployment with the capability `implementer`. The logic is in src/todos/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createTodosRouteHandlers } from "@/todos/http";
import { reviewActionsFor, todosServiceFor } from "@/todos/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/projects/[projectId]/todos">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, projectId } = await context.params;
  return withWorkspace(workspace, "view", (access) =>
    createTodosRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: todosServiceFor(access.workspace.id),
      reviews: reviewActionsFor(access.workspace.id),
    }).listForProject(request, projectId),
  );
}
