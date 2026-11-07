// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the Issues tab makes to the app's own routes (#925): the tickets of the project (`GET /api/w/:workspace/projects/:projectId/issues`)
// and, for the drawer, the run that is on an issue (`GET /api/w/:workspace/workflows/:workflowId/runs/:runId`). Browser side; no secrets.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../ui/json-request.ts";
import { workspaceApiPath } from "../workspaces/paths.ts";
import type { TicketList } from "../tracker/service.ts";
import type { RunView } from "../workflow-runs/service.ts";

/** The most the list answers in one call; the board shows the issues that changed last. */
export const ISSUES_LISTED = 200;

export type IssuesApi = {
  /** The open and the closed tickets of the project, newest change first. */
  list(projectId: string): Promise<RequestResult<TicketList>>;
  run(
    workflowId: string,
    runId: string,
  ): Promise<RequestResult<{ run: RunView }>>;
};

export function createIssuesApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): IssuesApi {
  return {
    list: (projectId) =>
      requestJson<TicketList>(
        fetchImpl,
        "GET",
        `${workspaceApiPath(workspaceSlug, `/projects/${encodeURIComponent(projectId)}/issues`)}?state=all&limit=${String(ISSUES_LISTED)}`,
      ),
    run: (workflowId, runId) =>
      requestJson<{ run: RunView }>(
        fetchImpl,
        "GET",
        workspaceApiPath(
          workspaceSlug,
          `/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}`,
        ),
      ),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserIssuesApi(workspaceSlug: string): IssuesApi {
  return createIssuesApi((url, init) => fetch(url, init), workspaceSlug);
}

/** How often the board asks again: quickly while a lane is on an issue, slowly to notice the rest. */
export const ISSUES_POLL = { activeMs: 4000, idleMs: 15000 } as const;
