// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the runners page makes to the routes of #854 (`../http.ts`). The workspace is the one of the page that makes the call.
// Browser side; the only secret that passes here is the registration token, which is shown once and kept nowhere.
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { NewTokenView, RunnerList } from "../service.ts";

export type RunnerFleetApi = {
  list(): Promise<RequestResult<RunnerList>>;
  createToken(): Promise<RequestResult<NewTokenView>>;
  revoke(id: string): Promise<RequestResult<{ revoked: true }>>;
};

export function createRunnerFleetApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): RunnerFleetApi {
  const base = workspaceApiPath(workspaceSlug, "/runners");
  return {
    list: () => requestJson(fetchImpl, "GET", base),
    createToken: () => requestJson(fetchImpl, "POST", `${base}/tokens`),
    revoke: (id) =>
      requestJson(
        fetchImpl,
        "POST",
        `${base}/${encodeURIComponent(id)}/revoke`,
      ),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserRunnerFleetApi(workspaceSlug: string): RunnerFleetApi {
  return createRunnerFleetApi((url, init) => fetch(url, init), workspaceSlug);
}
