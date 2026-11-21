// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server behind the workflow routes (#833): the real database. The capability check
// (`requireImplementerCapability`) is the Implementer's, in `../implementer/shared.ts`; the workflows are part of the factory.
import "server-only";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createNamedRunnersRepository } from "../db/repositories/named-runners-repository.ts";
import { createMcpOAuthRepository } from "../db/repositories/mcp-oauth-repository.ts";
import { createMcpServersRepository } from "../db/repositories/mcp-servers-repository.ts";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createRunnersRepository } from "../db/repositories/runners-repository.ts";
import { implementerModelsFor } from "../implementer/shared.ts";
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
  let checker: ReturnType<typeof implementerModelsFor> | undefined;
  return createWorkflowService({
    workflows: createWorkflowsRepository(db, workspaceId),
    projects: createProjectsRepository(db, workspaceId),
    environments: createImplementerEnvironmentsRepository(db, workspaceId),
    profiles: createProfilesRepository(db, workspaceId),
    // Built when a document names a model of its own, not for every request (it reads the workspace's keys, which a validation without one
    // never needs), and then once: the entitlements it reads are held by the one checker for every model of the save.
    models: {
      check: (model) =>
        (checker ??= implementerModelsFor(workspaceId)).check(model),
    },
    mcpServers: createMcpServersRepository(db, workspaceId),
    mcpOAuth: createMcpOAuthRepository(db, workspaceId),
    onlineRunners: onlineRunnersFrom(createRunnersRepository(db, workspaceId)),
    runners: createNamedRunnersRepository(db, workspaceId),
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
}
