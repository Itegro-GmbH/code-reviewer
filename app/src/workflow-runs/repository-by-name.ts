// SPDX-License-Identifier: LicenseRef-Proprietary

// The repository of a workspace that an entry of the `repos` of an agent step names (#1092, epic #1090): by its full name (`owner/name`), without
// regard to case (GitHub's own rule), among the workspace's active repositories only. The repositories repository is the workspace's own (every query
// filters by it), so a repository of another workspace is never found: the answer is the same as for a repository that does not exist.
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";

export function repositoryByName(
  repositories: Pick<RepositoriesRepository, "list">,
): (fullName: string) => Promise<{ id: string; fullName: string } | undefined> {
  return async (fullName) => {
    const wanted = fullName.toLowerCase();
    const found = (await repositories.list({ active: true })).find(
      (repository) => repository.fullName.toLowerCase() === wanted,
    );
    return found === undefined
      ? undefined
      : { id: found.id, fullName: found.fullName };
  };
}
