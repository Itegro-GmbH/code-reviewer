// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira connections of a workspace as the "New project" dialog offers them (#1038): the site and whether it needs reconnecting, never a
// token. Nothing is read where the deployment has no Atlassian settings (the dialog then says to connect a site first).
import "server-only";
import { createJiraConnectionsRepository } from "../db/repositories/jira-connections-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { isJiraConfigured } from "../jira/shared.ts";
import type { JiraConnectionChoice } from "./ui/new-project-dialog.tsx";

export async function jiraConnectionChoicesFor(
  workspaceId: string,
): Promise<JiraConnectionChoice[]> {
  if (!isJiraConfigured()) return [];
  const connections = await createJiraConnectionsRepository(
    getDatabase(),
    workspaceId,
  ).list();
  return connections.map((connection) => ({
    id: connection.id,
    siteName: connection.siteName,
    siteUrl: connection.siteUrl,
    broken: connection.status === "broken",
  }));
}
