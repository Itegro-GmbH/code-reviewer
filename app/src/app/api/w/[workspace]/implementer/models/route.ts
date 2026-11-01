// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/implementer/models (#755): the models a task can be sent to, for the model picker. On the workspace's own
// key the providers with a saved key and their catalog models, on the operator's key the released entries the claim would run
// (never a provider or a model id). Only in a deployment with the capability `implementer`. The logic is in
// src/implementer/models.ts and src/implementer/http.ts.
import { connection } from "next/server";
import { createImplementerRouteHandlers } from "@/implementer/http";
import {
  implementerServiceFor,
  requireImplementerCapability,
} from "@/implementer/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/implementer/models">,
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
    }).models(request),
  );
}
