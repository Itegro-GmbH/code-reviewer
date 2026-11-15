// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira ticket provider (#1039, #1040, epic #1034): reads and writes the tickets of the Jira project a project's ticket source names. A
// ticket is named by its text key (`PROJ-7`); a key of another Jira project is none of this source's tickets. The write-back (a comment, the
// edit of the factory's own comment, labels, the transition to a status) is `ticket-writer.ts`. The mirror and the webhook do not go through
// the provider (`src/jira/mirror.ts`, `webhook-handler.ts`). The reader and the writer of a workspace's connections are looked up per call:
// the provider is one object of the process and the tokens are the workspace's.
import {
  TicketProviderError,
  type TicketProvider,
  type TicketRead,
  type TicketScope,
} from "../integrations/ticket-provider.ts";
import { isJiraIssueKey, projectKeyOfIssueKey } from "./issue.ts";
import type { JiraIssueReader } from "./issue-reader.ts";
import type { JiraTicketWriter } from "./ticket-writer.ts";

export const JIRA_TICKET_PROVIDER_ID = "jira";

/** The Jira source of a scope and the key, when the key is an issue of that Jira project; otherwise a ticket this source does not have. */
function targetOf(
  scope: TicketScope,
  key: string,
): { connectionId: string; projectKey: string; workspaceId: string } {
  if (
    scope.jira === undefined ||
    projectKeyOfIssueKey(key) !== scope.jira.projectKey
  )
    throw new TicketProviderError(
      "ticket_not_found",
      "The ticket is not an issue of the Jira project of this project's ticket source.",
    );
  return { ...scope.jira, workspaceId: scope.integration.workspaceId };
}

export function createJiraTicketProvider(deps: {
  readerFor(workspaceId: string): Promise<JiraIssueReader>;
  /** Left out: the provider only reads (a server or a test that does not write). */
  writerFor?(workspaceId: string): Promise<JiraTicketWriter>;
}): TicketProvider {
  const { writerFor } = deps;
  const writes: Partial<TicketProvider> =
    writerFor === undefined
      ? {}
      : {
          async commentOnTicket(scope, key, body, options) {
            const target = targetOf(scope, key);
            return (await writerFor(target.workspaceId)).comment(
              target.connectionId,
              key,
              body,
              options,
            );
          },
          async updateTicketComment(scope, key, commentId, body, signal) {
            const target = targetOf(scope, key);
            await (
              await writerFor(target.workspaceId)
            ).updateComment(target.connectionId, key, commentId, body, signal);
          },
          async changeTicketLabels(scope, key, change, signal) {
            const target = targetOf(scope, key);
            return (await writerFor(target.workspaceId)).changeLabels(
              target.connectionId,
              key,
              change,
              signal,
            );
          },
          async setTicketStatus(scope, key, move, signal) {
            const target = targetOf(scope, key);
            return (await writerFor(target.workspaceId)).setStatus(
              target.connectionId,
              target.projectKey,
              key,
              move.status,
              signal,
            );
          },
        };
  return {
    ...writes,
    id: JIRA_TICKET_PROVIDER_ID,
    boardless: true,
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
