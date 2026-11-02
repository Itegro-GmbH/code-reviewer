// SPDX-License-Identifier: LicenseRef-Proprietary

// PUT and DELETE /api/w/:workspace/environments/:environmentId (#818): change or delete an environment of the workspace. Owners
// and Admins (`manage_implementer_environments`). A task that started with the environment holds its own copy of size and script,
// so neither call touches a running or a past task. Only in a deployment with the capability `implementer`. The logic is in
// src/implementer/environments/.
import { connection } from "next/server";
import { createEnvironmentRouteHandlers } from "@/implementer/environments/http";
import { environmentServiceFor } from "@/implementer/environments/shared";
import { requireImplementerCapability } from "@/implementer/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function PUT(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/environments/[environmentId]">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, environmentId } = await context.params;
  return withWorkspace(workspace, "manage_implementer_environments", (access) =>
    createEnvironmentRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: environmentServiceFor(access.workspace.id),
    }).update(request, environmentId),
  );
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/environments/[environmentId]">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, environmentId } = await context.params;
  return withWorkspace(workspace, "manage_implementer_environments", (access) =>
    createEnvironmentRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: environmentServiceFor(access.workspace.id),
    }).remove(request, environmentId),
  );
}
