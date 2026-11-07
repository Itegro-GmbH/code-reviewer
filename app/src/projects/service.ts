// SPDX-License-Identifier: LicenseRef-Proprietary

// The project service: what the routes, the webhook intake and the UI use to turn a repository into
// a project and back. It validates its input, maps a refusal to a stable `ProjectError` code and lets
// the jobs module hook into a deactivation. All SQL is in the projects repository.
import type {
  ProjectListEntry,
  ProjectsRepository,
  StoredProject,
} from "../db/repositories/projects-repository.ts";
import { ProjectError } from "./errors.ts";
import { noopProjectHooks, type ProjectHooks } from "./hooks.ts";

export type ProjectService = {
  /**
   * Switches the project of a repository on, creating it the first time. Asking twice is fine: the
   * second answer says `unchanged`. Throws `PROJECT_REPOSITORY_NOT_FOUND`,
   * `PROJECT_REPOSITORY_UNAVAILABLE`, `PROJECT_INTEGRATION_UNAVAILABLE` or `PROJECT_REQUEST_INVALID`.
   */
  activateProject(repositoryId: string): Promise<{
    project: StoredProject;
    outcome: "created" | "reactivated" | "unchanged";
  }>;
  /**
   * Switches the project of a repository off and keeps it (row and settings). A repository without a
   * project, or with a project that is off, is not an error: `changed` is false. Throws
   * `PROJECT_REPOSITORY_NOT_FOUND` for an unknown repository.
   */
  deactivateProject(repositoryId: string): Promise<{
    project: StoredProject | undefined;
    changed: boolean;
  }>;
  /** The switched-on project of a repository whose platform still lists it, otherwise undefined. */
  getActiveProjectForRepository(
    repositoryId: string,
  ): Promise<StoredProject | undefined>;
  /**
   * Whether the repository a webhook names (integration row and the platform's repository id) has an
   * active project. The webhook route asks this before it does any work for a review trigger.
   */
  hasActiveProject(
    integrationId: string,
    repositoryExternalId: string,
  ): Promise<boolean>;
  /** Every repository with its integration, project and status, for the project list. */
  listProjects(): Promise<ProjectListEntry[]>;
  /** One entry of the list by the id of its repository; undefined for an id the list does not have. */
  findProject(repositoryId: string): Promise<ProjectListEntry | undefined>;
};

// A repository id is a UUID made by this app; anything else that is plausible is simply unknown.
const MAX_ID_LENGTH = 128;

function checkRepositoryId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAX_ID_LENGTH
  )
    throw new ProjectError(
      "PROJECT_REQUEST_INVALID",
      "The repository id is missing or malformed.",
    );
  return value;
}

export function createProjectService(deps: {
  projects: ProjectsRepository;
  hooks?: ProjectHooks | undefined;
}): ProjectService {
  const { projects } = deps;
  const hooks = deps.hooks ?? noopProjectHooks;

  return {
    async activateProject(repositoryId) {
      const result = await projects.activate(checkRepositoryId(repositoryId));
      switch (result.kind) {
        case "activated":
          if (result.outcome !== "unchanged")
            // What follows an activation never fails it (the hook's own contract); a throw is dropped.
            await Promise.resolve(
              hooks.onProjectActivated?.({
                projectId: result.project.id,
                repositoryId: result.project.repositoryId,
              }),
            ).catch(() => undefined);
          return { project: result.project, outcome: result.outcome };
        case "repository_not_found":
          throw new ProjectError(
            "PROJECT_REPOSITORY_NOT_FOUND",
            "There is no repository with this id.",
          );
        case "repository_unavailable":
          throw new ProjectError(
            "PROJECT_REPOSITORY_UNAVAILABLE",
            "The repository is no longer available on the platform and cannot be activated.",
          );
        case "integration_unavailable":
          throw new ProjectError(
            "PROJECT_INTEGRATION_UNAVAILABLE",
            "The installation of the repository is suspended or removed, so the repository cannot be activated.",
          );
      }
    },

    async deactivateProject(repositoryId) {
      const id = checkRepositoryId(repositoryId);
      const result = await projects.deactivate(id, (project, executor) =>
        hooks.onProjectDeactivated(
          { projectId: project.id, repositoryId: project.repositoryId },
          executor,
        ),
      );
      if (result.kind === "repository_not_found")
        throw new ProjectError(
          "PROJECT_REPOSITORY_NOT_FOUND",
          "There is no repository with this id.",
        );
      return { project: result.project, changed: result.changed };
    },

    getActiveProjectForRepository(repositoryId) {
      return projects.findActiveForRepository(repositoryId);
    },

    async hasActiveProject(integrationId, repositoryExternalId) {
      return (
        (await projects.findActiveForExternalRepository(
          integrationId,
          repositoryExternalId,
        )) !== undefined
      );
    },

    listProjects() {
      return projects.list();
    },

    async findProject(repositoryId) {
      // An id that cannot be one of ours is simply not found.
      if (
        typeof repositoryId !== "string" ||
        repositoryId.trim() === "" ||
        repositoryId.length > MAX_ID_LENGTH
      )
        return undefined;
      return projects.find(repositoryId);
    },
  };
}
