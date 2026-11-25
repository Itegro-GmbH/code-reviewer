// SPDX-License-Identifier: LicenseRef-Proprietary

// The routes behind the "Connected AI apps" list of the workspace settings (#1144):
//   GET  /api/w/:workspace/ai-apps                      the connections the viewer may see (every member)
//   POST /api/w/:workspace/ai-apps/:grantId/revoke      revokes one, then goes back to the page (a form post, no script needed)
// Both are for a member of the workspace (the route files ask `withWorkspace`); what a Member sees is limited in the service.
import { isCrossSite } from "../../http/request-checks.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import type { WorkspaceAccess } from "../../workspaces/access.ts";
import type { ConnectedAppsService } from "./service.ts";

const NO_STORE = { "cache-control": "no-store" };

export function createConnectedAppsHandlers(service: ConnectedAppsService) {
  const viewerOf = (access: WorkspaceAccess) => ({
    userId: access.user.id,
    role: access.role,
  });
  return {
    async list(access: WorkspaceAccess): Promise<Response> {
      const apps = await service.list(access.workspace.id, viewerOf(access));
      return Response.json({ apps }, { headers: NO_STORE });
    },

    async revoke(
      request: Request,
      access: WorkspaceAccess,
      grantId: string,
    ): Promise<Response> {
      if (isCrossSite(request))
        return Response.json(
          { error: "cross_site_request" },
          { status: 403, headers: NO_STORE },
        );
      const outcome = await service.revoke(
        access.workspace.id,
        viewerOf(access),
        grantId,
      );
      if (outcome === "not_found")
        return Response.json(
          { error: "not_found" },
          { status: 404, headers: NO_STORE },
        );
      return new Response(null, {
        status: 303,
        headers: {
          ...NO_STORE,
          location: workspacePath(access.workspace.slug, "/settings/ai-apps"),
        },
      });
    },
  };
}
