// SPDX-License-Identifier: LicenseRef-Proprietary

// GET and POST /api/w/:workspace/profiles (#843): the profiles of the workspace, and saving a new one (the body is the profile; it
// is validated first and refused with the full list of errors when it does not pass). Every member may do both
// (`start_implementer_task`, the right to use the factory). Only in a deployment with the capability `implementer`. The logic is in
// src/profiles/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createProfileRouteHandlers } from "@/profiles/http";
import { profileServiceFor } from "@/profiles/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/profiles">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createProfileRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: profileServiceFor(access.workspace.id),
    }).list(request),
  );
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/profiles">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createProfileRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: profileServiceFor(access.workspace.id),
    }).create(request),
  );
}
