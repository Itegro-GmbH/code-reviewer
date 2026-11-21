// SPDX-License-Identifier: LicenseRef-Proprietary

// The two reads the "Continue" form shares with the routes of #755 (`src/implementer/http.ts`): the models and the environments of the
// workspace. The first form of a task is gone (ADR 0007 decision 15: a task is a run of the one-off lane, #1105), so its calls are too.
// The workspace is the one of the page that makes the call. Browser side; no secrets here.
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { ModelOptions } from "../models.ts";
import type { EnvironmentPickerList } from "../environments/service.ts";

export type ImplementerApi = {
  models(): Promise<RequestResult<ModelOptions>>;
  /** The environments of the workspace (#818) for the picker: no scripts, only whether there is one. */
  environments(): Promise<RequestResult<EnvironmentPickerList>>;
};

export function createImplementerApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): ImplementerApi {
  const base = workspaceApiPath(workspaceSlug, "/implementer");
  return {
    models: () => requestJson(fetchImpl, "GET", `${base}/models`),
    environments: () =>
      requestJson(
        fetchImpl,
        "GET",
        `${workspaceApiPath(workspaceSlug, "/environments")}?view=picker`,
      ),
  };
}
