// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the environments page and the form's picker make to the routes of #818 (`../http.ts`). The workspace is the one of the
// page that makes the call. Browser side; no secrets here.
import { workspaceApiPath } from "../../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../../ui/json-request.ts";
import type { NetworkRule } from "../../../network-rule/network.ts";
import type { EnvironmentList, EnvironmentView } from "../service.ts";

/** The body of `POST` and `PUT`: the fields of an environment. */
export type EnvironmentBody =
  | {
      kind?: "hosted";
      name: string;
      vcpus: number;
      setupScript: string;
      /** #745, step 7: the rule for the agent's network. */
      network: NetworkRule;
    }
  | {
      /** #854: the labels a runner must have, instead of a size, a script and a network rule. */
      kind: "runner";
      name: string;
      labels: string[];
    };

export type EnvironmentApi = {
  list(): Promise<RequestResult<EnvironmentList>>;
  create(
    body: EnvironmentBody,
  ): Promise<RequestResult<{ environment: EnvironmentView }>>;
  update(
    id: string,
    body: EnvironmentBody,
  ): Promise<RequestResult<{ environment: EnvironmentView }>>;
  remove(id: string): Promise<RequestResult<{ removed: true }>>;
};

export function createEnvironmentApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): EnvironmentApi {
  const base = workspaceApiPath(workspaceSlug, "/environments");
  return {
    list: () => requestJson(fetchImpl, "GET", base),
    create: (body) => requestJson(fetchImpl, "POST", base, body),
    update: (id, body) =>
      requestJson(fetchImpl, "PUT", `${base}/${encodeURIComponent(id)}`, body),
    remove: (id) =>
      requestJson(fetchImpl, "DELETE", `${base}/${encodeURIComponent(id)}`),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserEnvironmentApi(workspaceSlug: string): EnvironmentApi {
  return createEnvironmentApi((url, init) => fetch(url, init), workspaceSlug);
}
