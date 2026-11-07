// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the Profiles page makes to the routes of #843 (`../http.ts`): one profile with its current version, and saving a body as its next
// version. The workspace is the one of the page that makes the call. Browser side; no secrets.
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { ProfileView } from "../service.ts";

export type ProfilesApi = {
  get(id: string): Promise<RequestResult<{ profile: ProfileView }>>;
  /** Saves `body` as the next version; only if `expectedVersion` still is the current one. */
  saveVersion(
    id: string,
    body: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<RequestResult<{ profile: ProfileView }>>;
};

export function createProfilesApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): ProfilesApi {
  const path = (id: string) =>
    workspaceApiPath(workspaceSlug, `/profiles/${encodeURIComponent(id)}`);
  return {
    get: (id) => requestJson(fetchImpl, "GET", path(id)),
    saveVersion: (id, body, expectedVersion) =>
      requestJson(
        fetchImpl,
        "PUT",
        `${path(id)}?expectedVersion=${String(expectedVersion)}`,
        body,
      ),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserProfilesApi(workspaceSlug: string): ProfilesApi {
  return createProfilesApi((url, init) => fetch(url, init), workspaceSlug);
}
