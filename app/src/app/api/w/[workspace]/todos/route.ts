// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/todos (#924): what waits for a person in every project of the workspace: the questions of agents, the reviews
// that are asked for and the last done ToDos. A query over the runs and the ticket mirror, nothing stored. Every member may read it. Only in
// a deployment with the capability `implementer`. The logic is in src/todos/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createTodosRouteHandlers } from "@/todos/http";
import { reviewActionsFor, todosServiceFor } from "@/todos/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/todos">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "view", (access) =>
    createTodosRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: todosServiceFor(access.workspace.id),
      reviews: reviewActionsFor(access.workspace.id),
    }).list(request),
  );
}
