// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of a project's Jira source on the running server (#1038): the reader of a workspace's connections (the token handling of the
// server behind two reads), the projects of a connection's site for the new-project dialog and the check of a creation, and the status names
// the lane editor offers. It lives here, not in `src/projects/`, because the projects module does not import `jira` (the two would form an import
// cycle). The logic is in `project-source.ts`.
import "server-only";
import { createJiraConnectionsRepository } from "../db/repositories/jira-connections-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { getDatabase } from "../db/startup.ts";
import type { NewProjectDependencies } from "../projects/create-http.ts";
import { boardStatusNamesFor } from "../projects/create-shared.ts";
import { jiraProjectsVia, statusNamesVia } from "./project-source.ts";
import { createJiraProjectReader } from "./projects.ts";
import { getJira, isJiraConfigured } from "./shared.ts";

function jiraReaderFor(workspaceId: string) {
  return createJiraProjectReader({ tokens: getJira().tokensFor(workspaceId) });
}

/**
 * The projects of the site of a Jira connection of the workspace, for the new-project dialog and the check of a creation. A deployment without
 * the Atlassian settings cannot ask Jira (`unavailable`); a connection of another workspace is none.
 */
export function jiraProjectsFor(
  workspaceId: string,
): NonNullable<NewProjectDependencies["jiraProjects"]> {
  if (!isJiraConfigured()) return async () => ({ kind: "unavailable" });
  return jiraProjectsVia({
    connections: createJiraConnectionsRepository(getDatabase(), workspaceId),
    reader: jiraReaderFor(workspaceId),
  });
}

/**
 * The status names of the tickets of a project (#1036), for the lane builder's status trigger: the options of the Status field of the
 * project's GitHub board, or Jira's own names of the workflow statuses of its Jira project. Empty when there is nothing to offer or the
 * platform cannot be asked: the page still loads and the names are typed. Never throws.
 */
export function statusNamesFor(
  workspaceId: string,
): (projectId: string) => Promise<string[]> {
  return statusNamesVia({
    projects: createProjectsRepository(getDatabase(), workspaceId),
    reader: isJiraConfigured()
      ? jiraReaderFor(workspaceId)
      : {
          listStatuses: async () => ({ ok: false, error: "jira_unavailable" }),
        },
    boardNames: boardStatusNamesFor(workspaceId),
  });
}
