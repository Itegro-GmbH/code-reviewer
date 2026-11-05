// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/runners/:runnerId/revoke (#854): revokes a runner of the workspace. Its next call is 401. Owners and Admins
// (`manage_runners`). Only in a deployment with the capability `implementer`. The logic is in src/runner-fleet/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createRunnerFleetRouteHandlers } from "@/runner-fleet/http";
import { runnerFleetServiceFor } from "@/runner-fleet/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/runners/[runnerId]/revoke">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace, runnerId } = await context.params;
  return withWorkspace(workspace, "manage_runners", (access) =>
    createRunnerFleetRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: runnerFleetServiceFor(access.workspace.id),
    }).revoke(request, runnerId),
  );
}
