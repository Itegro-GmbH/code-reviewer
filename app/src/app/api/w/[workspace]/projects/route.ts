// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/projects (#922): creates the project of a repository in the factory: its one ticket source (the GitHub issues of
// the repository) with the optional GitHub Project that is its board, and the built-in lanes it starts with. Switching a repository on or
// off for review stays `PUT .../repositories/:repositoryId/project`; this is the factory's "New project". Admins and Owners only
// (`manage_projects`), like that route, and only in a deployment with the capability `implementer`. The logic is in
// src/projects/create-http.ts. A project that was created starts the first full sync of its tickets after the response (#923).
import { after, connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { createNewProjectHandlers } from "@/projects/create-http";
import { boardsFor } from "@/projects/create-shared";
import { projectServiceFor } from "@/projects/shared";
import { trackerServiceFor } from "@/tracker/shared";
import { withWorkspace } from "@/workspaces/access-runtime";
import {
  BUILT_IN_LANE_KEYS,
  isBuiltInLaneKey,
} from "@/workflows/built-in-lanes";
import { workflowServiceFor } from "@/workflows/shared";

/** How long the first sync may read before it stops and waits for the next "Resync". */
const FIRST_SYNC_BUDGET_MS = 20_000;

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/projects">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_projects", (access) =>
    createNewProjectHandlers({
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
      boards: boardsFor(access.workspace.id),
      laneKeys: BUILT_IN_LANE_KEYS,
      copyLanes: (user, projectId, keys) =>
        workflowServiceFor(access.workspace.id).copyBuiltIn(
          user,
          projectId,
          keys.filter(isBuiltInLaneKey),
        ),
    }).create(request),
  );
}
