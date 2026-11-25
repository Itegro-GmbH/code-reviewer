// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { projectIdArg } from "./shared.ts";
import { lanesService, laneService, laneUrl } from "./services.ts";
import { projectsService } from "../projects/services.ts";

export const listLanes = defineTool({
  name: "list_lanes",
  title: "List lanes",
  description:
    "The lanes (workflows) of one project, or of every active project when `projectId` is left out. A lane is a saved, versioned workflow document; each entry has its id, project, name, current `version`, and the address of its page. Archived lanes are not listed. Use `get_lane` for the document.",
  scope: "factory:read",
  action: "start_implementer_task",
  input: { projectId: projectIdArg.optional() },
  async handler(context, args) {
    const lanes = context.services.use(lanesService);
    const projectIds =
      args.projectId !== undefined
        ? [args.projectId]
        : (await context.services.use(projectsService).listProjects())
            .filter((entry) => entry.project?.active === true)
            .map((entry) => (entry.project as { id: string }).id);
    const found = await Promise.all(
      projectIds.map((projectId) => laneService(() => lanes.list(projectId))),
    );
    const maximum = found[0]?.maximum;
    return {
      lanes: found.flatMap((list) =>
        list.workflows.map((lane) => ({
          ...lane,
          url: laneUrl(context, lane.id),
        })),
      ),
      ...(maximum === undefined ? {} : { maximumPerProject: maximum }),
    };
  },
});
