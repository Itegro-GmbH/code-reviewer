// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/runs/:id/steps?after=<seq>&limit=<n>: what the agent of a run of the Implementer thought, said and did,
// the parts that changed after the cursor (#745, live view). Protected like the run: the workspace is the one in the address, for
// a member only, and the run is looked up in that workspace. The logic is in src/runs/http.ts and src/runs/steps-service.ts.
import { connection } from "next/server";
import { createRunStepsRouteHandlers } from "@/runs/http";
import { runStepsServiceFor } from "@/runs/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/runs/[id]/steps">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, id } = await context.params;
  return withWorkspace(workspace, "view", (access) =>
    createRunStepsRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: runStepsServiceFor(access.workspace.id),
    }).steps(request, id),
  );
}
