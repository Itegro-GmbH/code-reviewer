// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server behind the workflow routes (#833): the real database. The capability check
// (`requireImplementerCapability`) is the Implementer's, in `../implementer/shared.ts`; the workflows are part of the factory.
import "server-only";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createWorkflowService, type WorkflowService } from "./service.ts";

/** The workflow service of one workspace. */
export function workflowServiceFor(workspaceId: string): WorkflowService {
  const db = getDatabase();
  return createWorkflowService({
    workflows: createWorkflowsRepository(db, workspaceId),
    environments: createImplementerEnvironmentsRepository(db, workspaceId),
  });
}
