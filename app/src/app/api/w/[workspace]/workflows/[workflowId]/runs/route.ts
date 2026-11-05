// SPDX-License-Identifier: LicenseRef-Proprietary

// POST and GET /api/w/:workspace/workflows/:workflowId/runs (#844): start a run of a saved workflow by hand (the body is
// `{ input, clientRequestId }`; the same request id answers the run it made before), and list the newest runs of the workflow. The
// right is the one to start an Implementer task (`start_implementer_task`): a run starts tasks. Only in a deployment with the
// capability `implementer`. The logic is in src/workflow-runs/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createWorkflowRunRouteHandlers } from "@/workflow-runs/http";
import { workflowRunServiceFor } from "@/workflow-runs/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/workflows/[workflowId]/runs">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace, workflowId } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createWorkflowRunRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: workflowRunServiceFor(access.workspace.id),
    }).start(request, workflowId),
  );
}

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/workflows/[workflowId]/runs">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, workflowId } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createWorkflowRunRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: workflowRunServiceFor(access.workspace.id),
    }).list(request, workflowId),
  );
}
