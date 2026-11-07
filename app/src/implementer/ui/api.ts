// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the form makes to the routes of #755 (`src/implementer/http.ts`): the repositories, the branches of one, the
// models and the start, and two reads of the profile routes (#843). The workspace is the one of the page that makes the call. Browser side; no secrets here.
import type { ModelChoice } from "../../db/implementer-model-choice.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { ModelOptions } from "../models.ts";
import type { EnvironmentPickerList } from "../environments/service.ts";
import type { BranchChoices, RepositoryChoice } from "../service.ts";

/** The body of `POST .../implementer/tasks`. */
export type StartTaskRequest = {
  repositoryId: string;
  baseBranch: string;
  branch: string;
  instruction: string;
  /** Left out when a profile is named: the profile's version brings the model (#843). */
  model?: ModelChoice;
  /** Whole US cents; left out when the person set no limit of their own, and when a profile is named (it brings its own). */
  costLimitCents?: number;
  /** A profile of the workspace, `<name>@<version>` for the version the form shows (#843); left out for none. */
  profile?: string;
  /** The environment of the workspace to start with (#818); left out for the standard. */
  environmentId?: string;
  /** One per form load: a retry of the same form is the same task. */
  clientRequestId: string;
};

/**
 * What the form reads of the profile routes (#843, `GET .../profiles` and `GET .../profiles/:id`): the fields it uses, declared here
 * so that the Implementer does not import the profile module, which imports the Implementer.
 */
export type ProfileChoice = {
  id: string;
  name: string;
  /** The current version. */
  version: number;
  /** Set once the profile is archived; the list does not hold such a profile. */
  archivedAt: string | null;
};
export type ProfileDetail = {
  /** The version the document is. */
  documentVersion: number;
  document: {
    model: ModelChoice;
    /** Whether a turn of this profile may push branches. */
    canPush: boolean;
  };
};

export type ImplementerApi = {
  repositories(): Promise<RequestResult<{ repositories: RepositoryChoice[] }>>;
  branches(repositoryId: string): Promise<RequestResult<BranchChoices>>;
  models(): Promise<RequestResult<ModelOptions>>;
  /** The environments of the workspace (#818) for the picker: no scripts, only whether there is one. */
  environments(): Promise<RequestResult<EnvironmentPickerList>>;
  /** The profiles of the workspace that are not archived (#843), by name. */
  profiles(): Promise<RequestResult<{ profiles: ProfileChoice[] }>>;
  /** One profile with its current version, for the model, the cost limit and the push right the form shows. */
  profile(
    profileId: string,
  ): Promise<RequestResult<{ profile: ProfileDetail }>>;
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
    environments: () =>
      requestJson(
        fetchImpl,
        "GET",
        `${workspaceApiPath(workspaceSlug, "/environments")}?view=picker`,
      ),
    profiles: () =>
      requestJson(
        fetchImpl,
        "GET",
        workspaceApiPath(workspaceSlug, "/profiles"),
      ),
    profile: (profileId) =>
      requestJson(
        fetchImpl,
        "GET",
        `${workspaceApiPath(workspaceSlug, "/profiles")}/${encodeURIComponent(profileId)}`,
      ),
    startTask: (request) =>
      requestJson(fetchImpl, "POST", `${base}/tasks`, request),
  };
}

/** The real thing, for the component; tests hand in their own. */
export function browserImplementerApi(workspaceSlug: string): ImplementerApi {
  return createImplementerApi((url, init) => fetch(url, init), workspaceSlug);
}
