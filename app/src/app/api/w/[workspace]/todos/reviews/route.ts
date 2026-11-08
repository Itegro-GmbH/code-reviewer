// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/todos/reviews (#924): approves or asks for changes on a pull request of a lane that a review is asked for, as a
// review of the GitHub App in the name of the person ("Review by @login"). The right is the one to start an Implementer task
// (`start_implementer_task`), as for answering a question: whoever may start a run may review its pull request. Only in a deployment with
// the capability `implementer`. The logic is in src/todos/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createTodosRouteHandlers } from "@/todos/http";
import { reviewActionsFor, todosServiceFor } from "@/todos/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/todos/reviews">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createTodosRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: todosServiceFor(access.workspace.id),
      reviews: reviewActionsFor(access.workspace.id),
    }).review(request),
  );
}
