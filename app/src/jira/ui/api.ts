// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the Jira section of the Integrations page makes to the app's own routes (src/jira/http.ts). Browser side; no secrets: an
// answer holds an address at Atlassian (the consent page) and nothing else. The workspace is the one of the page that makes the call.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";

export type JiraApi = {
  /** The address of the consent page; with a connection id, to connect that connection again. */
  connect(
    connectionId?: string,
  ): Promise<RequestResult<{ ok: true; url: string }>>;
  choose(cloudId: string): Promise<RequestResult<{ ok: true }>>;
  remove(connectionId: string): Promise<RequestResult<{ ok: true }>>;
};

export function createJiraApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): JiraApi {
  const path = (rest: string) => workspaceApiPath(workspaceSlug, rest);
  return {
    connect: (connectionId) =>
      requestJson(
        fetchImpl,
        "POST",
        path("/jira/connect"),
        connectionId === undefined ? {} : { connectionId },
      ),
    choose: (cloudId) =>
      requestJson(fetchImpl, "POST", path("/jira/choose"), { cloudId }),
    remove: (connectionId) =>
      requestJson(
        fetchImpl,
        "DELETE",
        path(`/jira/connections/${encodeURIComponent(connectionId)}`),
      ),
  };
}

export function browserJiraApi(workspaceSlug: string): JiraApi {
  return createJiraApi((url, init) => fetch(url, init), workspaceSlug);
}
