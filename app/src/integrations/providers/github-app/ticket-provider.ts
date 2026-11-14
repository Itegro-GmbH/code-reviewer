// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub App as a TicketProvider (#1035): the issues of a repository are the tickets, the key of a ticket is its issue number as text.
// The calls are those the git provider's ticket methods made before; only the face changed. The issue-style calls (comment, edit of the
// comment, labels) are shared with the git provider (`issue-actions.ts`), which uses them below a pull request.
import { IntegrationError } from "../../errors.ts";
import type { TicketProvider } from "../../ticket-provider.ts";
import { ticketNumberOfKey } from "../../ticket-provider.ts";
import { actionScope } from "./action-scope.ts";
import type { GithubClientSource } from "./client-source.ts";
import {
  BOARD_STATUS_TOKEN_PERMISSIONS,
  COMMENT_READ_TOKEN_PERMISSIONS,
  TRACKER_BOARD_TOKEN_PERMISSIONS,
  TRACKER_READ_TOKEN_PERMISSIONS,
  jobTokenRepositoryIds,
  toActionError,
  toReadError,
} from "./job-access.ts";
import type { InstallationPermissions, JobTokenScope } from "./client.ts";
import { createIssueActions } from "./issue-actions.ts";
import { parseTrackerChange } from "./tracker-events.ts";

export const GITHUB_TICKET_PROVIDER_ID = "github";

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch {
    return undefined;
  }
}

/** The issue a key names; a key that is no number is a request the platform would refuse. */
function issueNumberOf(key: string): number {
  const number = ticketNumberOfKey(key);
  if (number === undefined)
    throw new IntegrationError(
      "INTEGRATION_REQUEST_REFUSED",
      "A GitHub issue is named by its number.",
    );
  return number;
}

export function createGithubTicketProvider(
  source: GithubClientSource,
): TicketProvider {
  const { getClient } = source;
  const issues = createIssueActions(source);

  return {
    id: GITHUB_TICKET_PROVIDER_ID,

    isTicketKey: (key) => ticketNumberOfKey(key) !== undefined,

    async readTicket({ integration, repo }, key, signal) {
      // A key that is no number names no issue.
      const number = ticketNumberOfKey(key);
      if (number === undefined) return null;
      try {
        const issue = await (
          await getClient()
        ).getIssue(
          integration.externalId,
          actionScope(integration, repo, COMMENT_READ_TOKEN_PERMISSIONS),
          repo.fullName,
          number,
          signal,
        );
        return issue === null ? null : { ...issue, key: String(issue.number) };
      } catch (error) {
        throw toReadError(error);
      }
    },

    async commentOnTicket({ integration, repo }, key, body, options) {
      return issues.commentOnIssue(
        integration,
        repo,
        issueNumberOf(key),
        body,
        options,
      );
    },

    updateTicketComment({ integration, repo }, commentId, body, signal) {
      return issues.updateIssueComment(
        integration,
        repo,
        commentId,
        body,
        signal,
      );
    },

    async changeTicketLabels({ integration, repo }, key, change, signal) {
      return issues.changeIssueLabels(
        integration,
        repo,
        issueNumberOf(key),
        change,
        signal,
      );
    },

    async setTicketStatus({ integration, repo }, key, move, signal) {
      const number = ticketNumberOfKey(key);
      if (number === undefined) return { kind: "issue_not_found" };
      try {
        return await (
          await getClient()
        ).moveIssueOnBoard(
          integration.externalId,
          actionScope(integration, repo, BOARD_STATUS_TOKEN_PERMISSIONS),
          repo.fullName,
          number,
          move,
          signal,
        );
      } catch (error) {
        throw toActionError(error);
      }
    },

    async parseTrackerChange(integration, request) {
      const payload = await readJson(request);
      if (payload === undefined)
        return { kind: "ignored", reason: "the body is not valid JSON" };
      return parseTrackerChange({
        integrationId: integration.id,
        eventName: request.headers.get("x-github-event") ?? "",
        payload,
      });
    },

    async readTrackerPage({ integration, repo }, step, signal) {
      const repositoryIds = jobTokenRepositoryIds(repo.externalId);
      if (repo.integrationId !== integration.id || repositoryIds === null)
        throw new IntegrationError(
          "INTEGRATION_ACCESS_SCOPE_REFUSED",
          "The repository does not belong to this integration or has no usable id.",
        );
      const scope = (permissions: InstallationPermissions): JobTokenScope => ({
        repositoryIds,
        permissions,
      });
      try {
        const client = await getClient();
        if (step.phase === "issues") {
          const page = await client.readTrackerIssues(
            integration.externalId,
            scope(TRACKER_READ_TOKEN_PERMISSIONS),
            repo.fullName,
            step.page,
            step.since,
            signal,
          );
          return {
            phase: "issues",
            items: page.items,
            last: page.last,
            skipped: page.skipped,
          };
        }
        if (step.phase === "checks") {
          const page = await client.readTrackerChecks(
            integration.externalId,
            scope(TRACKER_READ_TOKEN_PERMISSIONS),
            repo.fullName,
            step.after,
            signal,
          );
          return {
            phase: "checks",
            pullRequests: page.pullRequests,
            last: page.last,
            lastNumber: page.lastNumber,
          };
        }
        const page = await client.readTrackerBoard(
          integration.externalId,
          scope(TRACKER_BOARD_TOKEN_PERMISSIONS),
          repo.fullName,
          step.after,
          step.boardId,
          signal,
        );
        return { phase: "board", ...page };
      } catch (error) {
        throw toReadError(error);
      }
    },

    async readBoardStatus({ integration, repo }, nodeId, boardId, signal) {
      const repositoryIds = jobTokenRepositoryIds(repo.externalId);
      if (repo.integrationId !== integration.id || repositoryIds === null)
        throw new IntegrationError(
          "INTEGRATION_ACCESS_SCOPE_REFUSED",
          "The repository does not belong to this integration or has no usable id.",
        );
      try {
        return await (
          await getClient()
        ).readTrackerBoardStatus(
          integration.externalId,
          { repositoryIds, permissions: TRACKER_BOARD_TOKEN_PERMISSIONS },
          nodeId,
          boardId,
          signal,
        );
      } catch (error) {
        throw toReadError(error);
      }
    },

    async listBoards({ integration, repo }, signal) {
      const repositoryIds = jobTokenRepositoryIds(repo.externalId);
      if (repo.integrationId !== integration.id || repositoryIds === null)
        throw new IntegrationError(
          "INTEGRATION_ACCESS_SCOPE_REFUSED",
          "The repository does not belong to this integration or has no usable id.",
        );
      try {
        const answer = await (
          await getClient()
        ).listRepositoryBoards(
          integration.externalId,
          {
            repositoryIds,
            permissions: TRACKER_BOARD_TOKEN_PERMISSIONS,
          },
          repo.fullName,
          signal,
        );
        return answer;
      } catch (error) {
        throw toReadError(error);
      }
    },

    async readChecksState({ integration, repo }, headSha, signal) {
      const repositoryIds = jobTokenRepositoryIds(repo.externalId);
      if (repo.integrationId !== integration.id || repositoryIds === null)
        throw new IntegrationError(
          "INTEGRATION_ACCESS_SCOPE_REFUSED",
          "The repository does not belong to this integration or has no usable id.",
        );
      try {
        return await (
          await getClient()
        ).readChecksState(
          integration.externalId,
          { repositoryIds, permissions: TRACKER_READ_TOKEN_PERMISSIONS },
          repo.fullName,
          headSha,
          signal,
        );
      } catch (error) {
        throw toReadError(error);
      }
    },
  };
}
