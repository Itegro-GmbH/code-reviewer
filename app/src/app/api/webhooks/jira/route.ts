// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/webhooks/jira: the address the dynamic webhooks of Jira Cloud call (#1039). The factory registers them itself, one per Jira
// project that is a project's ticket source, and the address carries the registration and its secret. Public: no session; the secret in
// the address (and Atlassian's bearer token when the delivery has one) is the authentication. All logic is in src/jira/ (webhook-handler.ts);
// the workflow engine is wired in here, because it depends on that folder and not the other way round.
import {
  jiraStatusesFor,
  jiraTicketProvider,
} from "../../../../jira/shared.ts";
import { getJiraWebhookHandler } from "../../../../jira/webhook-shared.ts";
import {
  jiraAnswersFor,
  jiraStatusTriggerFor,
} from "../../../../workflow-runs/shared.ts";

export async function POST(request: Request): Promise<Response> {
  return getJiraWebhookHandler({
    statusesFor: (workspaceId) =>
      jiraStatusTriggerFor(
        workspaceId,
        jiraTicketProvider,
        jiraStatusesFor(workspaceId),
      ),
    answersFor: jiraAnswersFor,
  })(request);
}
