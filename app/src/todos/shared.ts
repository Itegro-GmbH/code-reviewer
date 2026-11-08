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
import { createCountCache, openCountKey } from "./count-cache.ts";
import { createReviewActions, type ReviewActions } from "./review.ts";
import {
  createTodosService,
  type OpenCounts,
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

/** How long a count is kept: the badge asks on every page change, a count that is a few seconds old is as good. */
export const COUNT_TTL_MS = 10_000;
const counts = createCountCache<OpenCounts>({ ttlMs: COUNT_TTL_MS });

/**
 * How many ToDos of the workspace are open for the person, and in each project: the numbers on the sidebar's ToDos link and on the ToDos tab of a
 * project. Kept for a few seconds per workspace and person (reviews depend on who asks); `fresh` reads again, for the badge that follows an answer.
 */
export function openTodoCountFor(
  workspaceId: string,
  viewer: TodoViewer,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<OpenCounts> {
  return counts.read(
    openCountKey(workspaceId, viewer),
    () => todosServiceFor(workspaceId).countOpen(viewer),
    { fresh },
  );
}
