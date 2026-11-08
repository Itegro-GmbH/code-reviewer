// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the factory's new project (#922) on the running server: the boards of a repository read through the provider of its
// installation. Kept apart from `shared.ts`, which review-only deployments load too. The lanes a project copies are wired by the route
// file (this module does not know the workflows).
import "server-only";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import type { NewProjectDependencies } from "./create-http.ts";

/** The boards of a repository of the workspace, asked at GitHub with a token that may read boards and nothing else. */
export function boardsFor(
  workspaceId: string,
): NewProjectDependencies["boards"] {
  const db = getDatabase();
  const repositories = createRepositoriesRepository(db, workspaceId);
  const integrations = createIntegrationsRepository(db, workspaceId);
  return async (repositoryId) => {
    const repository = await repositories.get(repositoryId);
    if (repository === undefined || !repository.active)
      return { kind: "repository_not_found" };
    const integration = await integrations.get(repository.integrationId);
    if (integration === undefined || integration.status !== "active")
      return { kind: "integration_unavailable" };
    const provider = integrationRegistry.resolve(integration.type);
    // A platform without boards has none to offer, which is not an error.
    if (provider.listBoards === undefined)
      return { kind: "boards", available: true, boards: [] };
    try {
      const answer = await provider.listBoards(integration, {
        integrationId: repository.integrationId,
        externalId: repository.externalId,
        fullName: repository.fullName,
        url: repository.url,
      });
      return { kind: "boards", ...answer };
    } catch (error) {
      // The code of the error, never its text: it may carry what GitHub answered.
      console.error(
        "[projects] reading the boards of a repository failed:",
        error instanceof Error &&
          "code" in error &&
          typeof error.code === "string"
          ? error.code
          : "unknown",
      );
      return { kind: "failed" };
    }
  };
}
