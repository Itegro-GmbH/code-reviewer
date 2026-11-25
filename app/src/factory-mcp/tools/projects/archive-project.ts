// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";
import { projectService, projectsService } from "./services.ts";
import { projectIdArg, projectView } from "./shared.ts";

export const archiveProject = defineTool({
  name: "archive_project",
  title: "Archive a project",
  description:
    "Switches a project off and keeps it (its lanes, tickets and settings stay; its waiting jobs are cancelled and its Jira webhook is removed). Nothing new starts in it until a person switches it on again. Asking again answers `changed: false`. Owners and Admins only.",
  scope: "factory:control",
  action: "manage_projects",
  input: { projectId: projectIdArg },
  async handler(context, args) {
    const projects = context.services.use(projectsService);
    return projectService(async () => {
      const project = await projects.getProject(args.projectId);
      if (project === undefined)
        throw new ToolError("not_found", "There is no project with this id.");
      const result = await projects.deactivateProject(project.repositoryId);
      return {
        project: projectView(result.project ?? project),
        changed: result.changed,
      };
    });
  },
});
