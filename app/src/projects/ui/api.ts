// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the project list makes to the app's own routes: switch a project on or off
// (`PUT /api/w/:workspace/repositories/:id/project`, src/projects/http.ts) and run the sync by button
// (`POST /api/w/:workspace/integrations/sync`: the workspace's own connections only, an Admin or an Owner;
// the synchronization of the whole instance stays the instance admin's route,
// src/installation-binding/http.ts). The workspace of both calls is the one of the page that makes them.
// Browser side; no secrets here.
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";

export type SetActiveAnswer = {
  repositoryId: string;
  projectId: string | null;
  active: boolean;
  changed: boolean;
};

/** A board of the repository (#922) as the dialog of a new project lists it. */
export type BoardChoice = {
  projectV2Id: string;
  number: number;
  title: string;
  hasStatusField: boolean;
  statuses: string[];
};

export type BoardsAnswer = { available: boolean; boards: BoardChoice[] };

/** The body of a new project (#922): the repository, the board of its GitHub Project, and the built-in lanes to copy. */
export type NewProjectBody = {
  repositoryId: string;
  board: { projectV2Id: string } | null;
  lanes: string[];
};

export type CreatedProjectAnswer = {
  project: { id: string; repositoryId: string; active: boolean };
  lanes: { key: string; ok: boolean; workflowId?: string; code?: string }[];
};

/** What the sync button needs of an answer: how many repositories are new and the code of each problem. */
export type SyncResult = { added: number; errors: { code: string }[] };

export type ProjectsApi = {
  setActive(
    repositoryId: string,
    active: boolean,
  ): Promise<RequestResult<SetActiveAnswer>>;
  sync(): Promise<RequestResult<SyncResult>>;
};

/** The calls of the "New project" dialog of the factory (#922). */
export type NewProjectApi = {
  /** `GET .../repositories/:id/boards`: the boards the project of that repository could take. */
  boards(repositoryId: string): Promise<RequestResult<BoardsAnswer>>;
  /** `POST .../projects`: creates the project of a repository in the factory. */
  createProject(
    body: NewProjectBody,
  ): Promise<RequestResult<CreatedProjectAnswer>>;
};

export function createProjectsApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): ProjectsApi {
  return {
    setActive: (repositoryId, active) =>
      requestJson<SetActiveAnswer>(
        fetchImpl,
        "PUT",
        workspaceApiPath(
          workspaceSlug,
          `/repositories/${encodeURIComponent(repositoryId)}/project`,
        ),
        { active },
      ),
    sync: () =>
      requestJson<SyncResult>(
        fetchImpl,
        "POST",
        workspaceApiPath(workspaceSlug, "/integrations/sync"),
      ),
  };
}

export function createNewProjectApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): NewProjectApi {
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
    createProject: (body) =>
      requestJson<CreatedProjectAnswer>(
        fetchImpl,
        "POST",
        workspaceApiPath(workspaceSlug, "/projects"),
        body,
      ),
  };
}

/** The real thing, for the components; tests hand in their own. */
export function browserProjectsApi(workspaceSlug: string): ProjectsApi {
  return createProjectsApi((url, init) => fetch(url, init), workspaceSlug);
}

export function browserNewProjectApi(workspaceSlug: string): NewProjectApi {
  return createNewProjectApi((url, init) => fetch(url, init), workspaceSlug);
}

/** The synchronization of the whole instance: the instance admin's route of the admin portal. */
export const INSTANCE_SYNC_PATH = "/api/admin/integrations/sync";

export type InstanceSyncApi = Pick<ProjectsApi, "sync">;

export function createInstanceSyncApi(fetchImpl: FetchLike): InstanceSyncApi {
  return {
    sync: () => requestJson<SyncResult>(fetchImpl, "POST", INSTANCE_SYNC_PATH),
  };
}

export const browserInstanceSyncApi: InstanceSyncApi = createInstanceSyncApi(
  (url, init) => fetch(url, init),
);
