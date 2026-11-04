// SPDX-License-Identifier: LicenseRef-Proprietary

// GET, PUT and DELETE /api/w/:workspace/profiles/:profileId (#843): read a profile with its current version (`?version=n` for an
// older one) and its list of versions, save the body as its next version (validated first; `?expectedVersion=n` saves only if that
// is still the current version), or archive it (hidden from the list, no new version, never started, versions kept). A version is
// never changed. Every member may do all three (`start_implementer_task`). Only in a deployment
// with the capability `implementer`. The logic is in src/profiles/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createProfileRouteHandlers } from "@/profiles/http";
import { profileServiceFor } from "@/profiles/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/profiles/[profileId]">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, profileId } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createProfileRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: profileServiceFor(access.workspace.id),
    }).get(request, profileId),
  );
}

export async function PUT(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/profiles/[profileId]">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, profileId } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createProfileRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: profileServiceFor(access.workspace.id),
    }).update(request, profileId),
  );
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/profiles/[profileId]">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, profileId } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createProfileRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: profileServiceFor(access.workspace.id),
    }).archive(request, profileId),
  );
}
