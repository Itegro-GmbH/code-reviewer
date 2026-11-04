// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/workflows/validate (#833): checks a workflow document (the body) against the format and the workspace's
// environments and answers `{ valid, errors, budgetUsd?, steps }`; nothing is stored. A document with problems is a normal
// answer (200, `valid: false`, every problem with path, code, message and the names that were available). Every member may ask.
// Only in a deployment with the capability `implementer`. The logic is in src/workflows/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createWorkflowRouteHandlers } from "@/workflows/http";
import { workflowServiceFor } from "@/workflows/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/workflows/validate">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createWorkflowRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: workflowServiceFor(access.workspace.id),
    }).validate(request),
  );
}
