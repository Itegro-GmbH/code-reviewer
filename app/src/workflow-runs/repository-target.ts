// SPDX-License-Identifier: LicenseRef-Proprietary

// The target of a pull request step with `repos` (#1094, epic #1090): the active repository of the run's workspace that an entry names, with its
// connection. The lookup is the workspace's own (`repositoryByName` over the workspace-scoped repositories repository), so a repository of another
// workspace is answered like one that does not exist, and the connection must be usable (`targetOf` checks its status).
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type {
  GithubActionTarget,
  GithubConnectorDeps,
} from "./github-connectors.ts";
import { repositoryByName } from "./repository-by-name.ts";

export function targetOfNamedRepository(deps: {
  /** The repositories of one workspace, as `createRepositoriesRepository(db, workspaceId)` makes them. */
  repositories(workspaceId: string): Pick<RepositoriesRepository, "list">;
  /** The target of a repository of the workspace by its id: undefined when its connection is not active. */
  targetOf(
    workspaceId: string,
    repositoryId: string,
  ): Promise<GithubActionTarget | undefined>;
}): NonNullable<GithubConnectorDeps["targetOfRepository"]> {
  return async (call, fullName) => {
    const found = await repositoryByName(deps.repositories(call.workspaceId))(
      fullName,
    );
    return found === undefined
      ? undefined
      : deps.targetOf(call.workspaceId, found.id);
  };
}
