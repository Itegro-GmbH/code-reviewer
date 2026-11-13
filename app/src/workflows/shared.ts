// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server behind the workflow routes (#833): the real database. The capability check
// (`requireImplementerCapability`) is the Implementer's, in `../implementer/shared.ts`; the workflows are part of the factory.
import "server-only";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createRunnersRepository } from "../db/repositories/runners-repository.ts";
import { onlineRunnersFrom } from "../runner-identity/online.ts";
import {
  createWorkflowService,
  type WorkflowService,
  type WorkflowServiceDependencies,
} from "./service.ts";

/**
 * The workflow service of one workspace. `samples` (#927) is what the scope route adds: the latest run of a workflow, which this module
 * cannot read itself (the runs depend on the workflows, not the other way round).
 */
export function workflowServiceFor(
  workspaceId: string,
  options: Pick<WorkflowServiceDependencies, "samples"> = {},
): WorkflowService {
  const db = getDatabase();
  return createWorkflowService({
    workflows: createWorkflowsRepository(db, workspaceId),
    projects: createProjectsRepository(db, workspaceId),
    environments: createImplementerEnvironmentsRepository(db, workspaceId),
    profiles: createProfilesRepository(db, workspaceId),
    onlineRunners: onlineRunnersFrom(createRunnersRepository(db, workspaceId)),
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
}
