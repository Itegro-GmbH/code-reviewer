// SPDX-License-Identifier: LicenseRef-Proprietary

// What waits for a person in a workspace (#925, #924). The ToDos themselves (a question of an agent, a review that is asked for) are read
// by the service below (`service.ts`, behind `GET /api/w/:workspace/todos`). The count the sidebar badge shows is still 0 and the ToDos
// page is empty: both are the page's (#925) and need the viewer, which the badge does not know yet. The one function the badge and the
// page read, so they change in one place when the page reads the service.
import "server-only";
import { createTrackerRepository } from "../db/repositories/tracker-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { projectServiceFor } from "../projects/shared.ts";
import { connectorTargetOf } from "../workflow-runs/shared.ts";
import { createReviewActions, type ReviewActions } from "./review.ts";
import { createTodosService, type TodosService } from "./service.ts";

/** The ToDos of one workspace, read from the runs and the ticket mirror. */
export function todosServiceFor(workspaceId: string): TodosService {
  const db = getDatabase();
  return createTodosService({
    projects: projectServiceFor(workspaceId),
    workflows: createWorkflowsRepository(db, workspaceId),
    runs: createWorkflowRunsRepository(db, workspaceId),
    tracker: createTrackerRepository(db, workspaceId),
    memberLogins: () =>
      createWorkspaceMembersRepository(db, workspaceId).githubLogins(),
  });
}

/** The reviews given from the list of one workspace, through its GitHub App. */
export function reviewActionsFor(workspaceId: string): ReviewActions {
  return createReviewActions({
    todos: todosServiceFor(workspaceId),
    tracker: createTrackerRepository(getDatabase(), workspaceId),
    targetOf: (repositoryId) => connectorTargetOf(workspaceId, repositoryId),
  });
}

/** How many ToDos of the workspace are open. */
export async function openTodoCountFor(workspaceId: string): Promise<number> {
  void workspaceId;
  return 0;
}
