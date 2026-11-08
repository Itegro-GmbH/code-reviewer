// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/w/:workspace/todos/count (#925): how many ToDos of the workspace are open (`{ open, projects }`, the number of each project too), for the
// badge of the sidebar's ToDos link and the ToDos tab of a project. Every member may read it. Only in a deployment with the capability
// `implementer`. It counts the questions and the reviews asked of the person (`countOpen` of the ToDos service), kept for a few seconds per
// person; `?fresh=1` (the badge after an answer) reads again.
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { openTodoCountFor } from "@/todos/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function GET(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/todos/count">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace } = await context.params;
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  return withWorkspace(workspace, "view", async (access) =>
    Response.json(
      await openTodoCountFor(
        access.workspace.id,
        { githubLogin: access.user.githubLogin },
        { fresh },
      ),
      { headers: { "cache-control": "no-store" } },
    ),
  );
}
