// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/workflows/:workflowId/runs/:runId (#844): one run with its steps, as JSON. The right is the one to start an
// Implementer task (`start_implementer_task`). Only in a deployment with the capability `implementer`. The logic is in
// src/workflow-runs/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createWorkflowRunRouteHandlers } from "@/workflow-runs/http";
import { workflowRunServiceFor } from "@/workflow-runs/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/workflows/[workflowId]/runs/[runId]">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, workflowId, runId } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createWorkflowRunRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: workflowRunServiceFor(access.workspace.id),
    }).get(request, workflowId, runId),
  );
}
