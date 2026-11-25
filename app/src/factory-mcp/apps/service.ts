// SPDX-License-Identifier: LicenseRef-Proprietary

// "Connected AI apps" of a workspace (#1144): who connected which AI app with which scope, and the revocation. An Owner or Admin
// (`manage_ai_apps`) sees and revokes every connection of the workspace; a Member sees and revokes only their own, so a connection
// of somebody else is exactly as absent for them as one that does not exist.
import type { WorkspaceRole } from "../../db/workspace-roles.ts";
import { can } from "../../workspaces/permissions.ts";
import { formatScopeList } from "../scopes.ts";
import type { GrantView, ScopedGrants } from "../oauth/store.ts";

export type Viewer = { userId: string; role: WorkspaceRole };

export type ConnectedApp = {
  id: string;
  clientName: string;
  userName: string;
  /** The approved scope as text: `factory:read` or `factory:control`. */
  scope: string;
  connectedAt: string;
  lastUsedAt: string | null;
  /** Whether the connection is the viewer's own. */
  own: boolean;
};

export type ConnectedAppsService = ReturnType<
  typeof createConnectedAppsService
>;

export function createConnectedAppsService({
  grantsOf,
  now = () => new Date(),
}: {
  grantsOf: (workspaceId: string) => ScopedGrants;
  now?: () => Date;
}) {
  const visible = (rows: GrantView[], viewer: Viewer): GrantView[] =>
    can(viewer.role, "manage_ai_apps")
      ? rows
      : rows.filter((row) => row.userId === viewer.userId);

  return {
    async list(workspaceId: string, viewer: Viewer): Promise<ConnectedApp[]> {
      const rows = visible(await grantsOf(workspaceId).list(), viewer);
      return rows.map((row) => ({
        id: row.id,
        clientName: row.clientName,
        userName: row.userName,
        scope: formatScopeList(row.scopes),
        connectedAt: row.connectedAt,
        lastUsedAt: row.lastUsedAt,
        own: row.userId === viewer.userId,
      }));
    },

    /** `not_found` for a connection that is gone, of another workspace, or (for a Member) somebody else's. */
    async revoke(
      workspaceId: string,
      viewer: Viewer,
      grantId: string,
    ): Promise<"revoked" | "not_found"> {
      const grants = grantsOf(workspaceId);
      const allowed = visible(await grants.list(), viewer);
      if (!allowed.some((row) => row.id === grantId)) return "not_found";
      return (await grants.revoke(grantId, now().toISOString()))
        ? "revoked"
        : "not_found";
    },
  };
}
