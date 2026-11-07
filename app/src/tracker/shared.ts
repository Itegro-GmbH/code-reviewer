// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the ticket mirror on the running server (#923): the real database, registry and project service. The one place that
// decides where a change of a webhook goes and what a sync reads from.
import "server-only";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createTrackerRepository } from "../db/repositories/tracker-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { projectServiceFor } from "../projects/shared.ts";
import { createTrackerMirror, type TrackerMirror } from "./mirror.ts";
import { createTrackerService, type TrackerService } from "./service.ts";
import { createTrackerSync, type TrackerSync } from "./sync.ts";

const TYPE = "github_app";

/** The sync of the tickets of one workspace's repositories. */
export function trackerSyncFor(workspaceId: string): TrackerSync {
  return createTrackerSync({
    tracker: createTrackerRepository(getDatabase(), workspaceId),
    provider: integrationRegistry.resolve(TYPE),
  });
}

/** What a webhook delivery changes in the ticket mirror of one workspace. */
export function trackerMirrorFor(workspaceId: string): TrackerMirror {
  const db = getDatabase();
  const provider = integrationRegistry.resolve(TYPE);
  return createTrackerMirror({
    repositories: createRepositoriesRepository(db, workspaceId),
    projects: projectServiceFor(workspaceId),
    tracker: createTrackerRepository(db, workspaceId),
    async checksStateOf(integration, repo, headSha) {
      if (provider.readChecksState === undefined) return null;
      return provider.readChecksState(integration, repo, headSha);
    },
  });
}

/** The list of the tickets and the full sync of one workspace. */
export function trackerServiceFor(workspaceId: string): TrackerService {
  const db = getDatabase();
  return createTrackerService({
    repositories: createRepositoriesRepository(db, workspaceId),
    integrations: createIntegrationsRepository(db, workspaceId),
    projects: projectServiceFor(workspaceId),
    tracker: createTrackerRepository(db, workspaceId),
    runs: createWorkflowRunsRepository(db, workspaceId),
    sync: trackerSyncFor(workspaceId),
  });
}
