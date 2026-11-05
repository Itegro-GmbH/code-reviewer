// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/runs/:id/continuation (#841): what the "Continue" form of a run of the Implementer needs: the state of its
// session, the defaults of the last turn, the instruction that waits, and the size of the history. 404 for a run that is not the
// newest turn of a session of the workspace. Protected like the run: a member only. The logic is in src/implementer/follow-up.ts.
import { connection } from "next/server";
import { createImplementerRouteHandlers } from "@/implementer/http";
import {
  implementerServiceFor,
  requireImplementerCapability,
} from "@/implementer/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/runs/[id]/continuation">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  requireImplementerCapability();
  const { workspace, id } = await context.params;
  return withWorkspace(workspace, "view", (access) =>
    createImplementerRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: implementerServiceFor(access.workspace.id),
    }).continuation(request, id),
  );
}
