// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Setup tab of a project on a Jira project shows beyond the project itself (#1038): the name of its site and Jira's own names of the
// workflow statuses. Never throws: a connection that cannot be read or a site that cannot be asked leaves the name or the list empty, and the
// page says so.
import "server-only";
import { createJiraConnectionsRepository } from "../db/repositories/jira-connections-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { statusNamesFor } from "./source-shared.ts";

export async function jiraSetupFor(
  workspaceId: string,
  projectId: string,
): Promise<{ siteName: string | null; statuses: string[] }> {
  const [siteName, statuses] = await Promise.all([
    (async () => {
      try {
        const project = await createProjectsRepository(
          getDatabase(),
          workspaceId,
        ).getById(projectId);
        const connectionId = project?.ticketSource.connectionId;
        if (connectionId === undefined) return null;
        return (
          (
            await createJiraConnectionsRepository(
              getDatabase(),
              workspaceId,
            ).get(connectionId)
          )?.siteName ?? null
        );
      } catch {
        return null;
      }
    })(),
    statusNamesFor(workspaceId)(projectId),
  ]);
  return { siteName, statuses };
}
