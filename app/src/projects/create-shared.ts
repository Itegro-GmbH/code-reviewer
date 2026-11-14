// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the factory's new project (#922) on the running server: the boards of a repository read through the provider of its
// installation. Kept apart from `shared.ts`, which review-only deployments load too. The lanes a project copies are wired by the route
// file (this module does not know the workflows).
import "server-only";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { ticketProviderRegistry } from "../integrations/registry.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { boardStatusNames } from "./board-statuses.ts";
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
    // The tickets of a new project are GitHub issues so far (#1035: the ticket provider, not the git provider, knows boards).
    const provider = ticketProviderRegistry.get("github");
    // A platform without boards has none to offer, which is not an error.
    if (provider?.listBoards === undefined)
      return { kind: "boards", available: true, boards: [] };
    try {
      const answer = await provider.listBoards({
        integration,
        repo: {
          integrationId: repository.integrationId,
          externalId: repository.externalId,
          fullName: repository.fullName,
          url: repository.url,
        },
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

/**
 * The status names of the board of a project (#1036), for the lane builder's status trigger: the options of the Status field of the board the
 * project chose. Empty when the project has no board, or GitHub cannot be asked: the page still loads and the names are typed. Never throws.
 */
export function boardStatusNamesFor(
  workspaceId: string,
): (projectId: string) => Promise<string[]> {
  const projects = createProjectsRepository(getDatabase(), workspaceId);
  const boards = boardsFor(workspaceId);
  return async (projectId) => {
    try {
      const project = await projects.getById(projectId);
      const chosen = project?.ticketSource.board?.projectV2Id;
      // A project without a board has nothing to offer, so GitHub is not asked.
      if (project === undefined || chosen === undefined) return [];
      return boardStatusNames(await boards(project.repositoryId), chosen);
    } catch {
      return [];
    }
  };
}
