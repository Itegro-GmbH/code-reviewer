// SPDX-License-Identifier: LicenseRef-Proprietary

// GET, PUT and DELETE /api/w/:workspace/workflows/:workflowId (#833): read a workflow with its current version (`?version=n` for an
// older one) and its list of versions, save the body as its next version (validated first; `?expectedVersion=n` saves only if that
// is still the current version), or archive it (hidden from the list, no new version, never started, versions kept). A version is
// never changed. Every member may do all three (`start_implementer_task`). Only in a deployment
// with the capability `implementer`. The logic is in src/workflows/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createWorkflowRouteHandlers } from "@/workflows/http";
import { workflowServiceFor } from "@/workflows/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/workflows/[workflowId]">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, workflowId } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createWorkflowRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: workflowServiceFor(access.workspace.id),
    }).get(request, workflowId),
  );
}

export async function PUT(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/workflows/[workflowId]">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, workflowId } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createWorkflowRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: workflowServiceFor(access.workspace.id),
    }).update(request, workflowId),
  );
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/workflows/[workflowId]">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, workflowId } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createWorkflowRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: workflowServiceFor(access.workspace.id),
    }).archive(request, workflowId),
  );
}
