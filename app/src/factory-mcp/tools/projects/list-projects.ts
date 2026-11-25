// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { projectService, projectsService } from "./services.ts";
import { projectView, repositoryView } from "./shared.ts";

export const listProjects = defineTool({
  name: "list_projects",
  title: "List projects",
  description:
    "The projects of the workspace (a project is one repository with its ticket source and its lanes), each with its repository and `status` (`active`, `inactive` when switched off, `unavailable` when the platform no longer lists the repository). `repositoriesWithoutProject` are the repositories a project can still be created for with `create_project`.",
  scope: "factory:read",
  action: "start_implementer_task",
  input: {},
  async handler(context) {
    const entries = await projectService(() =>
      context.services.use(projectsService).listProjects(),
    );
    return {
      projects: entries.flatMap((entry) =>
        entry.project === null
          ? []
          : [
              {
                ...projectView(entry.project),
                status: entry.status,
                repository: repositoryView(entry),
              },
            ],
      ),
      repositoriesWithoutProject: entries
        .filter((entry) => entry.project === null && entry.repository.available)
        .map((entry) => repositoryView(entry)),
    };
  },
});
