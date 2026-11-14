// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of `POST /api/webhooks/jira` on the running server (#1039): the real database, the Atlassian settings read on every request,
// and for each workspace its projects, repositories, ticket mirror and (handed in by the route) the status trigger of the workflow engine.
import "server-only";
import { createJiraWebhookDirectory } from "../db/repositories/jira-webhook-directory-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createTrackerRepository } from "../db/repositories/tracker-repository.ts";
import { createWebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createJiraMirror } from "./mirror.ts";
import { getAtlassianConfig } from "./shared.ts";
import {
  createJiraWebhookHandler,
  type JiraStatusStarter,
  type JiraWebhookHandler,
} from "./webhook-handler.ts";

export function getJiraWebhookHandler(
  options: {
    /** What starts the lanes a status change in Jira starts in one workspace; the route passes it in. */
    statusesFor?: (workspaceId: string) => JiraStatusStarter;
  } = {},
): JiraWebhookHandler {
  const db = getDatabase();
  return createJiraWebhookHandler({
    directory: createJiraWebhookDirectory(db),
    deliveries: createWebhookDeliveriesRepository(db),
    clientSecret: () => {
      const config = getAtlassianConfig();
      return config.configured ? config.clientSecret : undefined;
    },
    // A delivery is handled in the workspace its registration belongs to.
    workspace: (workspaceId) => {
      const repositories = createRepositoriesRepository(db, workspaceId);
      return {
        projects: createProjectsRepository(db, workspaceId),
        repositoryName: async (repositoryId) =>
          (await repositories.get(repositoryId))?.fullName,
        mirror: createJiraMirror({
          tracker: createTrackerRepository(db, workspaceId),
        }),
        ...(options.statusesFor === undefined
          ? {}
          : { statuses: options.statusesFor(workspaceId) }),
      };
    },
  });
}
