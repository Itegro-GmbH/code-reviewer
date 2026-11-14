// SPDX-License-Identifier: LicenseRef-Proprietary

// The token scope of a call the app makes on one repository (#844, #1035): shared by the git provider and the ticket provider of this folder.
import { IntegrationError } from "../../errors.ts";
import type { Integration, RepoRef } from "../../types.ts";
import type { InstallationPermissions, JobTokenScope } from "./client.ts";
import { jobTokenRepositoryIds } from "./job-access.ts";

/** The token scope of a workflow action (#844): exactly this repository, and the permissions the action needs. */
export function actionScope(
  integration: Integration,
  repo: RepoRef,
  permissions: InstallationPermissions,
): JobTokenScope {
  const repositoryIds = jobTokenRepositoryIds(repo.externalId);
  if (repo.integrationId !== integration.id || repositoryIds === null)
    throw new IntegrationError(
      "INTEGRATION_ACCESS_SCOPE_REFUSED",
      "The repository does not belong to this integration or has no usable id.",
    );
  return { repositoryIds, permissions };
}
