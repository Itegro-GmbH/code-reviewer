// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the webhook route: the real database, registry, sync service and intake. This is the
// one place that decides where review triggers go.
import "server-only";
import { createIntegrationDirectory } from "../db/repositories/integration-directory-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createWebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { jobQueueFor } from "../jobs/shared.ts";
import { getGithubCredentialStore } from "../github-config/shared.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { getIntegrationSync } from "../integrations/sync/shared.ts";
import {
  createGithubAppWebhookHandler,
  type WebhookHandler,
  type WorkflowStarter,
} from "./github-app-handler.ts";
import { projectServiceFor } from "../projects/shared.ts";
import { reviewSettingsServiceFor } from "../review-settings/shared.ts";
import { createAutomaticReviewSettingsSource } from "./automatic-review-settings.ts";
import { consoleWebhookLogger } from "./logger.ts";
import { createJobQueueReviewTriggerIntake } from "./job-queue-intake.ts";
import type { ReviewTriggerIntake } from "./review-trigger-intake.ts";

/**
 * Where review triggers of one workspace go: into its job queue, as a thin mapping. The trigger
 * policy (active project, drafts, settings) is applied by the handler before it calls the
 * intake.
 */
export function getJobQueueReviewTriggerIntake(
  workspaceId: string,
): ReviewTriggerIntake {
  return createJobQueueReviewTriggerIntake({
    queue: jobQueueFor(workspaceId),
    repositories: createRepositoriesRepository(getDatabase(), workspaceId),
    logger: consoleWebhookLogger,
  });
}

/**
 * The handler of `POST /api/webhooks/github-app`, wired to the running server. `workflowsFor` is what starts the workflows of a label
 * on an issue in one workspace (#845); the route passes it in, because the engine depends on this folder and not the other way round.
 */
export function getGithubAppWebhookHandler(
  options: { workflowsFor?: (workspaceId: string) => WorkflowStarter } = {},
): WebhookHandler {
  const db = getDatabase();
  return createGithubAppWebhookHandler({
    registry: integrationRegistry,
    integrations: createIntegrationDirectory(db),
    deliveries: createWebhookDeliveriesRepository(db),
    sync: getIntegrationSync(),
    // A delivery is handled in the workspace its installation is linked to.
    workspace: (workspaceId) => ({
      projects: projectServiceFor(workspaceId),
      settingsFor: createAutomaticReviewSettingsSource({
        repositories: createRepositoriesRepository(db, workspaceId),
        settings: reviewSettingsServiceFor(workspaceId),
      }),
      intake: getJobQueueReviewTriggerIntake(workspaceId),
      ...(options.workflowsFor === undefined
        ? {}
        : { workflows: options.workflowsFor(workspaceId) }),
    }),
    automatic: {},
    logger: consoleWebhookLogger,
    // Nothing saved and no variable set is "not configured", the normal state, not an error to log.
    githubAppConfigured: async () =>
      (await getGithubCredentialStore().load()).source !== "none",
  });
}
