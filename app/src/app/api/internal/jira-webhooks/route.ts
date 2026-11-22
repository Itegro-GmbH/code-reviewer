// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/internal/jira-webhooks: the nightly extension of the Jira webhooks the factory registered (#1039), called by the platform's cron
// in serverless mode (and every 15 minutes with `?retry=pending` for the webhooks that wait for a try, #1131). Public for the session guard: CRON_SECRET is the credential. A deployment without the factory answers `skipped`.
// All logic is in src/cron/jira-webhooks.ts and src/jira/webhook-registrar.ts.
import { connection } from "next/server";
import { getCapabilities } from "../../../../capabilities/shared.ts";
import { handleJiraWebhooksCron } from "../../../../cron/jira-webhooks.ts";
import { createJiraWebhookDirectory } from "../../../../db/repositories/jira-webhook-directory-repository.ts";
import { getDatabase } from "../../../../db/startup.ts";
import { isJiraConfigured } from "../../../../jira/shared.ts";
import { jiraWebhookRegistrarFor } from "../../../../jira/webhook-registrar-shared.ts";

export async function GET(request: Request): Promise<Response> {
  await connection();
  return handleJiraWebhooksCron(request, {
    env: process.env,
    enabled: () => getCapabilities().has("implementer") && isJiraConfigured(),
    targets: (limit, options) =>
      createJiraWebhookDirectory(getDatabase()).listProjects(limit, options),
    reconcile: (workspaceId, projectId) =>
      jiraWebhookRegistrarFor(workspaceId).reconcile(projectId),
  });
}
