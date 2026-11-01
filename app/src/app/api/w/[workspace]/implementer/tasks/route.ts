// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/implementer/tasks (#755): sends a task to the Implementer: a new branch on a repository of the workspace,
// an instruction and a model. Every member may (`start_implementer_task`). Only in a deployment with the capability
// `implementer`. The logic is in src/implementer/service.ts and src/implementer/http.ts.
import { connection } from "next/server";
import { createImplementerRouteHandlers } from "@/implementer/http";
import {
  implementerServiceFor,
  requireImplementerCapability,
} from "@/implementer/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/implementer/tasks">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "start_implementer_task", (access) =>
    createImplementerRouteHandlers({
      requireUser: () => Promise.resolve(access.user),
      service: implementerServiceFor(access.workspace.id),
    }).start(request),
  );
}
