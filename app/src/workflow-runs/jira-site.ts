// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira site a ticket of the lane runs list links to (#1086), read from the stored connection of the project's ticket source. Kept apart
// from `shared.ts` (server only, builds the database access) so that the wiring has unit tests with a fake store.
import {
  defaultTicketSource,
  jiraSourceOf,
  type ProjectsRepository,
} from "../db/repositories/projects-repository.ts";
import type { JiraConnectionsRepository } from "../db/repositories/jira-connections-repository.ts";

/** Where the Jira tickets of a repository's project live now: the site's address and the key of the Jira project the tickets come from. */
export type JiraSiteOfRepository = { siteUrl: string; projectKey: string };

/**
 * The Jira site of the project of this repository: the CURRENT source of the project, not the one a run started with (the reference of a run
 * holds no site). The caller therefore links a ticket only when its key starts with `${projectKey}-`, so that a project that was pointed
 * at another site does not link its old runs to another site's ticket. `projects.get` (not `findActiveForRepository`) is used on purpose:
 * a project that is switched off still has its runs in the history, and their tickets stay linked.
 * Undefined for a project with another source (or none), a connection of another workspace and a connection that is gone: the repository of
 * the connection is scoped to the workspace, so another workspace's site is never reachable.
 */
export function jiraSiteLookup(deps: {
  projects: Pick<ProjectsRepository, "get">;
  jiraConnections: Pick<JiraConnectionsRepository, "get">;
}): (repositoryId: string) => Promise<JiraSiteOfRepository | undefined> {
  return async (repositoryId) => {
    const project = await deps.projects.get(repositoryId);
    const jira = jiraSourceOf(
      project?.ticketSource ?? defaultTicketSource(repositoryId),
    );
    if (jira === null) return undefined;
    const connection = await deps.jiraConnections.get(jira.connectionId);
    return connection === undefined
      ? undefined
      : { siteUrl: connection.siteUrl, projectKey: jira.projectKey };
  };
}
