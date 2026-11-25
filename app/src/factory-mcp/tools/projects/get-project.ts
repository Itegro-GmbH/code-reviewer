// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";
import { lanesService, laneService, laneUrl } from "../lanes/services.ts";
import { projectService, projectsService } from "./services.ts";
import { projectIdArg, projectView, repositoryView } from "./shared.ts";

export const getProject = defineTool({
  name: "get_project",
  title: "Get a project",
  description:
    "One project with its repository, its ticket source (the repository's issues with the optional GitHub board, or a Jira project) and its lanes.",
  scope: "factory:read",
  action: "start_implementer_task",
  input: { projectId: projectIdArg },
  async handler(context, args) {
    const entries = await projectService(() =>
      context.services.use(projectsService).listProjects(),
    );
    const entry = entries.find((one) => one.project?.id === args.projectId);
    if (entry?.project === undefined || entry.project === null)
      throw new ToolError("not_found", "There is no project with this id.");
    const lanes = await laneService(() =>
      context.services.use(lanesService).list(args.projectId),
    );
    return {
      project: {
        ...projectView(entry.project),
        status: entry.status,
        repository: repositoryView(entry),
      },
      lanes: lanes.workflows.map((lane) => ({
        ...lane,
        url: laneUrl(context, lane.id),
      })),
    };
  },
});
