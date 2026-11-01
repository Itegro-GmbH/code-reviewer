// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the form makes to the four routes of #755 (`src/implementer/http.ts`): the repositories, the branches of one, the
// models and the start. The workspace is the one of the page that makes the call. Browser side; no secrets here.
import type { ModelChoice } from "../../db/implementer-model-choice.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { ModelOptions } from "../models.ts";
import type { BranchChoices, RepositoryChoice } from "../service.ts";

/** The body of `POST .../implementer/tasks`. */
export type StartTaskRequest = {
  repositoryId: string;
  baseBranch: string;
  branch: string;
  instruction: string;
  model: ModelChoice;
  /** Whole US cents; left out when the person set no limit of their own. */
  costLimitCents?: number;
  /** One per form load: a retry of the same form is the same task. */
  clientRequestId: string;
};

export type ImplementerApi = {
  repositories(): Promise<RequestResult<{ repositories: RepositoryChoice[] }>>;
  branches(repositoryId: string): Promise<RequestResult<BranchChoices>>;
  models(): Promise<RequestResult<ModelOptions>>;
  startTask(
    request: StartTaskRequest,
  ): Promise<RequestResult<{ runId: string; sessionId: string }>>;
};

export function createImplementerApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): ImplementerApi {
  const base = workspaceApiPath(workspaceSlug, "/implementer");
  return {
    repositories: () => requestJson(fetchImpl, "GET", `${base}/repositories`),
    branches: (repositoryId) =>
      requestJson(
        fetchImpl,
        "GET",
        `${base}/repositories/${encodeURIComponent(repositoryId)}/branches`,
      ),
    models: () => requestJson(fetchImpl, "GET", `${base}/models`),
    startTask: (request) =>
      requestJson(fetchImpl, "POST", `${base}/tasks`, request),
  };
}

/** The real thing, for the component; tests hand in their own. */
export function browserImplementerApi(workspaceSlug: string): ImplementerApi {
  return createImplementerApi((url, init) => fetch(url, init), workspaceSlug);
}
