// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the ticket source card of the Setup tab makes (#937): the boards of the repository, the board of the project
// (`PUT /api/w/:workspace/projects/:projectId`, src/projects/create-http.ts) and the full sync of the ticket mirror
// (`POST /api/w/:workspace/repositories/:repositoryId/issues/sync`: 200 when the cache is complete, 202 while asking again continues it).
// Browser side; no secrets here.
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { BoardsAnswer } from "./api.ts";

/** What one call of the sync answers (src/tracker/sync.ts `SyncProgress`). */
export type ResyncProgress = {
  status: "done" | "partial";
  written: number;
  removed: number;
  skipped: number;
  boardAvailable: boolean;
};

export type SetupApi = {
  /** `GET .../repositories/:id/boards` */
  boards(repositoryId: string): Promise<RequestResult<BoardsAnswer>>;
  /** `PUT .../projects/:id`: the board by its GitHub Project id, or `null` for none. */
  setBoard(
    projectId: string,
    projectV2Id: string | null,
  ): Promise<RequestResult<{ project: { id: string } }>>;
  /** `POST .../repositories/:id/issues/sync`: one call of the full sync; aborting `signal` ends the call as a `NETWORK_ERROR`. */
  resync(
    repositoryId: string,
    signal?: AbortSignal,
  ): Promise<RequestResult<ResyncProgress>>;
};

export function createSetupApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): SetupApi {
  return {
    boards: (repositoryId) =>
      requestJson<BoardsAnswer>(
        fetchImpl,
        "GET",
        workspaceApiPath(
          workspaceSlug,
          `/repositories/${encodeURIComponent(repositoryId)}/boards`,
        ),
      ),
    setBoard: (projectId, projectV2Id) =>
      requestJson<{ project: { id: string } }>(
        fetchImpl,
        "PUT",
        workspaceApiPath(
          workspaceSlug,
          `/projects/${encodeURIComponent(projectId)}`,
        ),
        { board: projectV2Id === null ? null : { projectV2Id } },
      ),
    resync: (repositoryId, signal) =>
      requestJson<ResyncProgress>(
        fetchImpl,
        "POST",
        workspaceApiPath(
          workspaceSlug,
          `/repositories/${encodeURIComponent(repositoryId)}/issues/sync`,
        ),
        undefined,
        signal,
      ),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserSetupApi(workspaceSlug: string): SetupApi {
  return createSetupApi((url, init) => fetch(url, init), workspaceSlug);
}
