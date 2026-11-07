// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the workflow pages make to the app's own routes (#873): one run while it is polled, and the start of a run by hand. The
// workspace is the one of the page that makes the call. Browser side; no secrets.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../ui/json-request.ts";
import { workspaceApiPath } from "../workspaces/paths.ts";
import type { RunSummaryView, RunView } from "../workflow-runs/service.ts";

export type WorkflowRunsApi = {
  /** The newest runs of a workflow, without their steps. */
  list(workflowId: string): Promise<RequestResult<{ runs: RunSummaryView[] }>>;
  /** One run with its steps. */
  run(
    workflowId: string,
    runId: string,
  ): Promise<RequestResult<{ run: RunView }>>;
  /** Starts a run by hand. The same `clientRequestId` with the same input answers the run it made before. */
  start(
    workflowId: string,
    body: {
      trigger?: string;
      input: Record<string, unknown>;
      clientRequestId: string;
    },
  ): Promise<RequestResult<{ run: RunView }>>;
  /** Answers the question the run waits for (#920): the question the page showed, and an option by its number from 1 and/or a text. */
  answer(
    workflowId: string,
    runId: string,
    body: {
      question: { stepRunId: string; n: number };
      choice?: number;
      text?: string;
    },
  ): Promise<RequestResult<{ run: RunView }>>;
  /** Stops a run (#891). `requested`: it is told to stop; a repeat and a run that is over answer with their own outcome. */
  cancel(
    workflowId: string,
    runId: string,
  ): Promise<RequestResult<{ run: RunView; outcome: string }>>;
};

export function createWorkflowRunsApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): WorkflowRunsApi {
  const runsPath = (workflowId: string) =>
    workspaceApiPath(
      workspaceSlug,
      `/workflows/${encodeURIComponent(workflowId)}/runs`,
    );
  return {
    list: (workflowId) =>
      requestJson<{ runs: RunSummaryView[] }>(
        fetchImpl,
        "GET",
        runsPath(workflowId),
      ),
    run: (workflowId, runId) =>
      requestJson<{ run: RunView }>(
        fetchImpl,
        "GET",
        `${runsPath(workflowId)}/${encodeURIComponent(runId)}`,
      ),
    start: (workflowId, body) =>
      requestJson<{ run: RunView }>(
        fetchImpl,
        "POST",
        runsPath(workflowId),
        body,
      ),
    answer: (workflowId, runId, body) =>
      requestJson<{ run: RunView }>(
        fetchImpl,
        "POST",
        `${runsPath(workflowId)}/${encodeURIComponent(runId)}/answer`,
        body,
      ),
    cancel: (workflowId, runId) =>
      requestJson<{ run: RunView; outcome: string }>(
        fetchImpl,
        "POST",
        `${runsPath(workflowId)}/${encodeURIComponent(runId)}/cancel`,
      ),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserWorkflowRunsApi(workspaceSlug: string): WorkflowRunsApi {
  return createWorkflowRunsApi((url, init) => fetch(url, init), workspaceSlug);
}

/** How often the run page asks again while the run runs. */
export const WORKFLOW_RUN_POLL_MS = 3000;
