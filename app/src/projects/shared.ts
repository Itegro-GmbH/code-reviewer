// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server: the real database and the hooks other modules plug in. The one
// place that decides what happens when a project is deactivated: the job queue cancels the waiting
// jobs of the repository.
import "server-only";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { newProjectSettings } from "./new-project-settings.ts";
import { getDatabase } from "../db/startup.ts";
import { createJobProjectHooks } from "../jobs/project-hooks.ts";
import type { ProjectHooks } from "./hooks.ts";
import { createProjectService, type ProjectService } from "./service.ts";

/** What other modules do when a project is switched off: the job queue cancels its waiting jobs. */
export function getProjectHooks(workspaceId: string): ProjectHooks {
  return createJobProjectHooks(workspaceId);
}

/** The project service of one workspace. */
export function projectServiceFor(
  workspaceId: string,
  /**
   * What the caller does after a project was created or switched on (the route that switches it on starts the first sync of the ticket
   * mirror, #923: the ticket mirror depends on this module, so it is handed in and never imported here).
   */
  onProjectActivated?: ProjectHooks["onProjectActivated"],
): ProjectService {
  return createProjectService({
    projects: createProjectsRepository(
      getDatabase(),
      workspaceId,
      undefined,
      undefined,
      undefined,
      newProjectSettings,
    ),
    hooks: {
      ...getProjectHooks(workspaceId),
      ...(onProjectActivated === undefined ? {} : { onProjectActivated }),
    },
  });
}
