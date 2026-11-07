// SPDX-License-Identifier: LicenseRef-Proprietary

// PUT /api/w/:workspace/repositories/:repositoryId/project: switches the project of a repository on or off.
// Which repositories are reviewed is managed by Admins and Owners. Protected like every workspace route
// (src/workspaces/access-runtime.ts); the repository is looked up in the workspace of the address. The
// logic is in src/projects/http.ts. A project that was created or switched on starts the first full sync of its tickets (the ticket
// mirror, #923) after the response: it can take longer than a request, and a sync that stops early continues with "Resync".
import { after, connection } from "next/server";
import { createProjectRouteHandler } from "@/projects/http";
import { projectServiceFor } from "@/projects/shared";
import { trackerServiceFor } from "@/tracker/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

/** How long the first sync may read before it stops and waits for the next "Resync". */
const FIRST_SYNC_BUDGET_MS = 20_000;

export async function PUT(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/repositories/[repositoryId]/project">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace, repositoryId } = await context.params;
  return withWorkspace(workspace, "manage_projects", (access) =>
    createProjectRouteHandler({
      requireUser: () => Promise.resolve(access.user),
      service: projectServiceFor(
        access.workspace.id,
        async ({ repositoryId }) => {
          after(() =>
            trackerServiceFor(access.workspace.id)
              .sync(repositoryId, {
                deadline: Date.now() + FIRST_SYNC_BUDGET_MS,
              })
              .then(
                () => undefined,
                (error: unknown) =>
                  console.error(
                    `[tracker] the first sync of repository=${repositoryId} did not finish (${error instanceof Error ? error.name : "unknown"})`,
                  ),
              ),
          );
        },
      ),
    })(request, repositoryId),
  );
}
