// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the Jira webhook registrar on the running server (#1039): the repositories of one workspace, the connection's tokens, and
// the public address of the app. Used by the hooks of a project (`project-hooks.ts`) and the nightly job.
import "server-only";
import { loadAuthConfig } from "../auth/config.ts";
import { createJiraWebhooksRepository } from "../db/repositories/jira-webhooks-repository.ts";
import { createTrackerRepository } from "../db/repositories/tracker-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { getDatabase } from "../db/startup.ts";
import type { ProjectHooks } from "../projects/hooks.ts";
import {
  createJiraActivationHook,
  createJiraDeactivationHook,
} from "./project-hooks.ts";
import { getJira, isJiraConfigured } from "./shared.ts";
import {
  createJiraWebhookRegistrar,
  type JiraWebhookRegistrar,
} from "./webhook-registrar.ts";
import { createJiraWebhookApi } from "./webhooks-api.ts";

/** The registrar of one workspace; `reconcile` answers `jira_unavailable` where the Atlassian settings are not set (nothing can be asked of Jira). */
export function jiraWebhookRegistrarFor(
  workspaceId: string,
): JiraWebhookRegistrar {
  if (!isJiraConfigured())
    return {
      reconcile: async () => ({ outcome: "failed", error: "jira_unavailable" }),
    };
  const db = getDatabase();
  return createJiraWebhookRegistrar({
    webhooks: createJiraWebhooksRepository(db, workspaceId),
    projects: createProjectsRepository(db, workspaceId),
    api: createJiraWebhookApi({ tokens: getJira().tokensFor(workspaceId) }),
    publicUrl: loadAuthConfig(process.env).baseUrl,
  });
}

/** The activation hook of one workspace's project service (see `project-hooks.ts`), wired to the running server. */
export function withJiraActivation(
  workspaceId: string,
  next?: ProjectHooks["onProjectActivated"],
) {
  return createJiraActivationHook(
    {
      tracker: createTrackerRepository(getDatabase(), workspaceId),
      projects: createProjectsRepository(getDatabase(), workspaceId),
      webhooks: createJiraWebhooksRepository(getDatabase(), workspaceId),
      registrar: jiraWebhookRegistrarFor(workspaceId),
    },
    next,
  );
}

/** The hook after a project was switched off, wired to the running server. */
export function afterJiraDeactivation(workspaceId: string) {
  return createJiraDeactivationHook({
    registrar: jiraWebhookRegistrarFor(workspaceId),
  });
}
