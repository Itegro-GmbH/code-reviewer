// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the ToDos page makes to the app's own routes (#925): the list (`GET /api/w/:workspace/todos`, or the one of a project), a
// review (`POST .../todos/reviews`) and the answer to a question, which is the route of the run that exists (`.../workflows/:id/runs/:run/answer`,
// docs/workflows.md). Browser side; no secrets. Only types are imported from the server code.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import type { ReviewDecision, ReviewOutcome } from "../review.ts";
import type { TodoList } from "../service.ts";

export type AnswerBody = {
  question: { stepRunId: string; n: number };
  /** An option by its number, from 1. */
  choice?: number;
  text?: string;
};

export type ReviewBody = {
  repositoryId: string;
  number: number;
  decision: ReviewDecision;
  comment?: string;
};

export type TodosApi = {
  /** The ToDos of the workspace, or of one project. */
  list(projectId?: string): Promise<RequestResult<TodoList>>;
  answer(
    workflowId: string,
    runId: string,
    body: AnswerBody,
  ): Promise<RequestResult<unknown>>;
  review(body: ReviewBody): Promise<RequestResult<ReviewOutcome>>;
};

export function createTodosApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): TodosApi {
  return {
    list: (projectId) =>
      requestJson<TodoList>(
        fetchImpl,
        "GET",
        workspaceApiPath(
          workspaceSlug,
          projectId === undefined
            ? "/todos"
            : `/projects/${encodeURIComponent(projectId)}/todos`,
        ),
      ),
    answer: (workflowId, runId, body) =>
      requestJson<unknown>(
        fetchImpl,
        "POST",
        workspaceApiPath(
          workspaceSlug,
          `/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/answer`,
        ),
        body,
      ),
    review: (body) =>
      requestJson<ReviewOutcome>(
        fetchImpl,
        "POST",
        workspaceApiPath(workspaceSlug, "/todos/reviews"),
        body,
      ),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserTodosApi(workspaceSlug: string): TodosApi {
  return createTodosApi((url, init) => fetch(url, init), workspaceSlug);
}

/** How often the list is read again: a slow interval, a question or a review is not a matter of seconds. */
export const TODOS_POLL_MS = 20_000;
