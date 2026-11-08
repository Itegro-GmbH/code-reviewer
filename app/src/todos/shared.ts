// SPDX-License-Identifier: LicenseRef-Proprietary

// What waits for a person in a workspace (#925, #924). The ToDos themselves (a question of an agent, a review that is asked for) are read
// by the service below (`service.ts`, behind `GET /api/w/:workspace/todos`); the count the sidebar badge shows is the service's `countOpen`
// for the viewer (reviews depend on who asks).
import "server-only";
import { createTrackerRepository } from "../db/repositories/tracker-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { projectServiceFor } from "../projects/shared.ts";
import { connectorTargetOf } from "../workflow-runs/shared.ts";
import { createReviewActions, type ReviewActions } from "./review.ts";
import {
  createTodosService,
  type TodosService,
  type TodoViewer,
} from "./service.ts";

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

/** How many ToDos of the workspace are open for the person: the number on the sidebar's ToDos link. */
export async function openTodoCountFor(
  workspaceId: string,
  viewer: TodoViewer,
): Promise<number> {
  return todosServiceFor(workspaceId).countOpen(viewer);
}
