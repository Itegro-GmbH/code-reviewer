// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the runs pages make to the app's own routes while they poll: the list
// (`GET /api/w/:workspace/runs`, src/runs/http.ts) one run (`GET /api/w/:workspace/runs/:id`) and the steps of a run of the Implementer (`.../runs/:id/steps`). The
// workspace is the one of the page that makes the call. Browser side; no secrets.
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { StepsSnapshot } from "../steps-view.ts";
import type {
  RunDetailSnapshot,
  RunsFilter,
  RunsSnapshot,
} from "../run-view.ts";

export type { RunsFilter };

export type RunsApi = {
  list(filter: RunsFilter): Promise<RequestResult<RunsSnapshot>>;
  detail(id: string): Promise<RequestResult<RunDetailSnapshot>>;
  /** What the agent of a run of the Implementer did after the cursor `after` (#745, live view). */
  steps(id: string, after: number): Promise<RequestResult<StepsSnapshot>>;
};

export function createRunsApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): RunsApi {
  return {
    list(filter) {
      const query = new URLSearchParams();
      if (filter.repositoryId !== undefined)
        query.set("repository", filter.repositoryId);
      if (filter.status !== undefined) query.set("status", filter.status);
      const text = query.toString();
      const path = workspaceApiPath(workspaceSlug, "/runs");
      return requestJson<RunsSnapshot>(
        fetchImpl,
        "GET",
        text === "" ? path : `${path}?${text}`,
      );
    },
    detail: (id) =>
      requestJson<RunDetailSnapshot>(
        fetchImpl,
        "GET",
        workspaceApiPath(workspaceSlug, `/runs/${encodeURIComponent(id)}`),
      ),
    steps: (id, after) =>
      requestJson<StepsSnapshot>(
        fetchImpl,
        "GET",
        `${workspaceApiPath(workspaceSlug, `/runs/${encodeURIComponent(id)}/steps`)}?after=${String(after)}`,
      ),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserRunsApi(workspaceSlug: string): RunsApi {
  return createRunsApi((url, init) => fetch(url, init), workspaceSlug);
}

/** How often the pages ask again: quickly while a run can change, slowly to notice new runs. */
export const RUNS_POLL = {
  activeMs: 3000,
  /** The list keeps asking, so a run that starts after the page was opened shows up. */
  listIdleMs: 5000,
} as const;
