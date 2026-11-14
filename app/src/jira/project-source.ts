// SPDX-License-Identifier: LicenseRef-Proprietary

// What a project's Jira source asks of Jira (#1038; this module is `jira`'s, not `projects`': the projects module does not import `jira`), over a connection of the workspace: the projects of its site (the new-project dialog
// and the check of a creation) and the status names of the project a source names (the status picker of `ticket.statusChanged`). The reader
// and the repositories are passed in (`create-shared.ts` wires the real ones on the running server), so tests wire fakes or the fake
// Atlassian. Never throws: a project the editor cannot get names for simply has none to offer.
import type { JiraConnectionsRepository } from "../db/repositories/jira-connections-repository.ts";
import {
  jiraSourceOf,
  type ProjectsRepository,
} from "../db/repositories/projects-repository.ts";
import type { JiraProjectsAnswer } from "../projects/create-http.ts";
import type { JiraProjectReader } from "./projects.ts";

/** The projects of the site of one of the workspace's connections; a connection of another workspace is `connection_not_found`. */
export function jiraProjectsVia({
  connections,
  reader,
}: {
  connections: Pick<JiraConnectionsRepository, "get">;
  reader: Pick<JiraProjectReader, "listProjects">;
}): (connectionId: string) => Promise<JiraProjectsAnswer> {
  return async (connectionId) => {
    const connection = await connections.get(connectionId);
    if (connection === undefined) return { kind: "connection_not_found" };
    // A broken connection makes no call to Atlassian (src/jira/tokens.ts); the answer says what to do.
    if (connection.status === "broken") return { kind: "connection_broken" };
    const result = await reader.listProjects(connectionId);
    if (result.ok)
      return {
        kind: "projects",
        complete: result.complete,
        projects: result.projects.map(({ key, name }) => ({ key, name })),
      };
    if (result.error === "jira_connection_broken")
      return { kind: "connection_broken" };
    if (result.error === "jira_connection_not_found")
      return { kind: "connection_not_found" };
    return { kind: "unavailable" };
  };
}

/**
 * The status names of a project's tickets, for the lane builder's status trigger: Jira's own names of the workflow statuses of the Jira
 * project the source names, or (any other source) what `boardNames` says. Empty when there is nothing to offer or Jira cannot be asked.
 */
export function statusNamesVia({
  projects,
  reader,
  boardNames,
}: {
  projects: Pick<ProjectsRepository, "getById">;
  reader: Pick<JiraProjectReader, "listStatuses">;
  boardNames: (projectId: string) => Promise<string[]>;
}): (projectId: string) => Promise<string[]> {
  return async (projectId) => {
    try {
      const project = await projects.getById(projectId);
      if (project === undefined) return [];
      const jira = jiraSourceOf(project.ticketSource);
      if (jira === null) return await boardNames(projectId);
      const result = await reader.listStatuses(
        jira.connectionId,
        jira.projectKey,
      );
      return result.ok ? result.statuses.map((status) => status.name) : [];
    } catch {
      return [];
    }
  };
}
