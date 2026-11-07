// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server: the real database and the hooks other modules plug in. The one
// place that decides what happens when a project is deactivated: the job queue cancels the waiting
// jobs of the repository.
import "server-only";
import { after } from "next/server";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { newProjectSettings } from "./new-project-settings.ts";
import { getDatabase } from "../db/startup.ts";
import { createJobProjectHooks } from "../jobs/project-hooks.ts";
import type { ProjectHooks } from "./hooks.ts";
import { createProjectService, type ProjectService } from "./service.ts";

/**
 * What other modules do when a project is switched off (the job queue cancels its waiting jobs) or on (the ticket mirror starts its
 * first full sync, #923, after the response: it can take longer than a request, and a sync that stops early continues with the next
 * "Resync").
 */
export function getProjectHooks(workspaceId: string): ProjectHooks {
  return {
    ...createJobProjectHooks(workspaceId),
    async onProjectActivated({ repositoryId }) {
      const work = async () => {
        // Loaded here: the ticket mirror wires itself from the project service, which this module makes.
        const { trackerServiceFor } = await import("../tracker/shared.ts");
        await trackerServiceFor(workspaceId).sync(repositoryId, {
          deadline: Date.now() + 20_000,
        });
      };
      const run = () =>
        work().catch((error: unknown) =>
          console.error(
            `[tracker] the first sync of repository=${repositoryId} did not finish (${error instanceof Error ? error.name : "unknown"})`,
          ),
        );
      try {
        after(run);
      } catch {
        // Outside a request (a script): the work just starts.
        void run();
      }
    },
  };
}

/** The project service of one workspace. */
export function projectServiceFor(workspaceId: string): ProjectService {
  return createProjectService({
    projects: createProjectsRepository(
      getDatabase(),
      workspaceId,
      undefined,
      undefined,
      undefined,
      newProjectSettings,
    ),
    hooks: getProjectHooks(workspaceId),
  });
}
