// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira ticket provider (#1039, epic #1034): reads a ticket of the Jira project a project's ticket source names. A ticket is named by its
// text key (`PROJ-7`). Only the READ is here: comments, labels and transitions (the write-back) are #1040, so the ticket actions of a lane
// find a provider without those methods and end with `ticket_provider_unsupported`. The mirror and the webhook do not go through the
// provider (`src/jira/mirror.ts`, `webhook-handler.ts`). The reader of a workspace's connections is looked up per call: the provider is
// one object of the process and the tokens are the workspace's.
import type {
  TicketProvider,
  TicketRead,
  TicketScope,
} from "../integrations/ticket-provider.ts";
import { isJiraIssueKey } from "./issue.ts";
import type { JiraIssueReader } from "./issue-reader.ts";

export const JIRA_TICKET_PROVIDER_ID = "jira";

export function createJiraTicketProvider(deps: {
  readerFor(workspaceId: string): Promise<JiraIssueReader>;
}): TicketProvider {
  return {
    id: JIRA_TICKET_PROVIDER_ID,
    isTicketKey: isJiraIssueKey,

    async readTicket(
      scope: TicketScope,
      key: string,
    ): Promise<TicketRead | null> {
      if (scope.jira === undefined) return null;
      const reader = await deps.readerFor(scope.integration.workspaceId);
      const read = await reader.read(scope.jira.connectionId, key);
      // A failure is not "no ticket": the caller must be able to tell a site that cannot be asked from a key that is none.
      if (!read.ok) throw new Error(read.error);
      const { issue } = read;
      // An issue of another project of the site is not a ticket of this project's source.
      if (issue === null || issue.projectKey !== scope.jira.projectKey)
        return null;
      return {
        key: issue.key,
        title: issue.title,
        body: issue.body,
        url: issue.url,
        labels: issue.labels,
        assignees: issue.assignees,
        type: issue.type,
        status: issue.status,
      };
    },
  };
}
