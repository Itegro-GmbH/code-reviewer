// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/runners/tokens (#854): makes a registration token for a new runner. It is valid for one hour, usable once,
// and shown once in the answer; the app keeps only its hash. Owners and Admins (`manage_runners`). Only in a deployment with the
// capability `implementer`. The logic is in src/runner-fleet/.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createRunnerFleetRouteHandlers } from "@/runner-fleet/http";
import { runnerFleetServiceFor } from "@/runner-fleet/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/runners/tokens">,
): Promise<Response> {
  await connection();
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_runners", (access) =>
    createRunnerFleetRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: runnerFleetServiceFor(access.workspace.id),
    }).createToken(request),
  );
}
