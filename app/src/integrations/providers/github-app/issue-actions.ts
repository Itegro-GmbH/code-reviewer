// SPDX-License-Identifier: LicenseRef-Proprietary

// The three issue-style calls of the GitHub App (#844, #920): a comment, the edit of the app's own comment and the labels. GitHub numbers
// issues and pull requests alike, so the git provider uses them for the conversation below a pull request and the ticket provider
// (`ticket-provider.ts`) for the issues of a ticket source (#1035): one implementation, two faces.
import type { IntegrationProvider } from "../../provider.ts";
import { actionScope } from "./action-scope.ts";
import type { GithubClientSource } from "./client-source.ts";
import { ISSUE_ACTION_TOKEN_PERMISSIONS, toActionError } from "./job-access.ts";

export type IssueActions = Required<
  Pick<
    IntegrationProvider,
    "commentOnIssue" | "updateIssueComment" | "changeIssueLabels"
  >
>;

export function createIssueActions(source: GithubClientSource): IssueActions {
  const { getClient, getConfig } = source;
  return {
    async commentOnIssue(integration, repo, issueNumber, body, options = {}) {
      try {
        const { signal, marker, since } = options;
        const client = await getClient();
        const scope = actionScope(
          integration,
          repo,
          ISSUE_ACTION_TOKEN_PERMISSIONS,
        );
        if (marker !== undefined) {
          const botLogin = `${(await getConfig()).slug}[bot]`;
          const earlier = await client.listIssueComments(
            integration.externalId,
            scope,
            repo.fullName,
            issueNumber,
            {
              ...(since === undefined ? {} : { since }),
              ...(signal === undefined ? {} : { signal }),
            },
          );
          // Only the app's own comment counts: anybody can copy a marker into theirs.
          const found = earlier.find(
            (comment) =>
              comment.authorLogin === botLogin && comment.body.includes(marker),
          );
          if (found !== undefined)
            return {
              url: `${repo.url}/issues/${String(issueNumber)}#issuecomment-${found.id}`,
              existing: true,
              id: found.id,
            };
        }
        const { url, id } = await client.createIssueComment(
          integration.externalId,
          scope,
          repo.fullName,
          issueNumber,
          body,
          signal,
        );
        return { url, existing: false, id };
      } catch (error) {
        throw toActionError(error);
      }
    },

    async updateIssueComment(integration, repo, commentId, body, signal) {
      try {
        await (
          await getClient()
        ).updateIssueComment(
          integration.externalId,
          actionScope(integration, repo, ISSUE_ACTION_TOKEN_PERMISSIONS),
          repo.fullName,
          commentId,
          body,
          signal,
        );
      } catch (error) {
        throw toActionError(error);
      }
    },

    async changeIssueLabels(integration, repo, issueNumber, change, signal) {
      try {
        return {
          labels: await (
            await getClient()
          ).changeIssueLabels(
            integration.externalId,
            actionScope(integration, repo, ISSUE_ACTION_TOKEN_PERMISSIONS),
            repo.fullName,
            issueNumber,
            change,
            signal,
          ),
        };
      } catch (error) {
        throw toActionError(error);
      }
    },
  };
}
