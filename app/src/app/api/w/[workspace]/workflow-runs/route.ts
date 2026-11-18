// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/workflow-runs (#1078): the runs of every lane of the workspace, the active ones first, then the newest first, one
// page at a time (`?status=active|waiting|ended|failed&project=<repository id>&lane=<workflow id>&cursor=&limit=`). The right is the one of
// the other workflow-run routes (`start_implementer_task`). Only in a deployment with the capability `implementer`. The logic is in
// src/workflow-runs/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createWorkflowRunRouteHandlers } from "@/workflow-runs/http";
import { workflowRunServiceFor } from "@/workflow-runs/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/workflow-runs">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createWorkflowRunRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: workflowRunServiceFor(access.workspace.id),
    }).listWorkspace(request),
  );
}
