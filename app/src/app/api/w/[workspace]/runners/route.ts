// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/runners (#854): the runners of the workspace on customers' own machines, with their labels, version, manifest,
// last seen and state. Every member may list them (they name the labels an environment asks for), Owners and Admins register and
// revoke (`manage_runners`). Only in a deployment with the capability `implementer`. The logic is in src/runner-fleet/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createRunnerFleetRouteHandlers } from "@/runner-fleet/http";
import { runnerFleetServiceFor } from "@/runner-fleet/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/runners">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createRunnerFleetRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: runnerFleetServiceFor(access.workspace.id),
    }).list(request),
  );
}
