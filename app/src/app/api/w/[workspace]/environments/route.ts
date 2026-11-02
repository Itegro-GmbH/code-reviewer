// SPDX-License-Identifier: LicenseRef-Proprietary

// GET and POST /api/w/:workspace/environments (#818): the environments of the Implementer (a size and a setup script) of the
// workspace. Every member may list them (they can use them: the form's picker reads this route), Owners and Admins create
// (`manage_implementer_environments`). Only in a deployment with the capability `implementer`. The logic is in
// src/implementer/environments/.
import { connection } from "next/server";
import { createEnvironmentRouteHandlers } from "@/implementer/environments/http";
import { environmentServiceFor } from "@/implementer/environments/shared";
import { requireImplementerCapability } from "@/implementer/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/environments">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createEnvironmentRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: environmentServiceFor(access.workspace.id),
    }).list(request),
  );
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/environments">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_implementer_environments", (access) =>
    createEnvironmentRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: environmentServiceFor(access.workspace.id),
    }).create(request),
  );
}
