// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/workflows/scope (#927): the values the step at `at` of a workflow document can reach, by the validator's own
// scope rules, with their types and a sample of the latest run. The body is `{ document, at, targetRoots?, workflowId? }`; the
// document may be unsaved (the lane builder edits one) and may have problems; nothing is stored. Every member may ask. Only in a
// deployment with the capability `implementer`. The logic is in src/workflows/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { runSamplesFor } from "@/workflow-runs/shared";
import { createWorkflowRouteHandlers } from "@/workflows/http";
import { workflowServiceFor } from "@/workflows/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/workflows/scope">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createWorkflowRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: workflowServiceFor(access.workspace.id, {
        samples: runSamplesFor(access.workspace.id),
      }),
    }).scope(request),
  );
}
