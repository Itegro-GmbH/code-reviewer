// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/todos/count (#925): how many ToDos of the workspace are open, for the badge of the sidebar's ToDos link. Every
// member may read it. Only in a deployment with the capability `implementer`. It counts the questions and the reviews asked of the person (`countOpen` of the ToDos service).
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { openTodoCountFor } from "@/todos/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/w/[workspace]/todos/count">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "view", async (access) =>
    Response.json(
      {
        open: await openTodoCountFor(access.workspace.id, {
          githubLogin: access.user.githubLogin,
        }),
      },
      { headers: { "cache-control": "no-store" } },
    ),
  );
}
