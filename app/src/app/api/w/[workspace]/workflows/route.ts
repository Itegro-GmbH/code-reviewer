// SPDX-License-Identifier: LicenseRef-Proprietary

// GET and POST /api/w/:workspace/workflows (#833): the workflows of the workspace, and saving a new one (the body is the workflow
// document; it is validated first and refused with the full list of errors when it does not pass). Every member may do both
// (`start_implementer_task`, the right to use the factory). Only in a deployment with the capability `implementer`. The logic is in
// src/workflows/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createWorkflowRouteHandlers } from "@/workflows/http";
import { workflowServiceFor } from "@/workflows/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/workflows">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createWorkflowRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: workflowServiceFor(access.workspace.id),
    }).list(request),
  );
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/workflows">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createWorkflowRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: workflowServiceFor(access.workspace.id),
    }).create(request),
  );
}
