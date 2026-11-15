// SPDX-License-Identifier: LicenseRef-Proprietary

// What a project's switching on and off does for Jira (#1039): the routes that create, switch on or switch off a project hand these to the
// project service (the projects module may not import `jira`, so the routes wire them in, like the first sync of the ticket mirror).
//
//  - Switched on with a Jira source: the ticket mirror's rows of the other provider (the repository's GitHub issues) are cleared, and so
//    are the Jira rows of another Jira project (or of another connection: the webhook row still names the old one), so the project does not
//    show them and their numbers do not collide with the Jira rows that come in (the mirror's primary key is `(repository, number)`:
//    `OLD-7` and `NEW-7` cannot both be there). The webhook is registered at Jira.
//  - Switched on with a GitHub source: the Jira rows of the repository are cleared and a webhook the project had is deleted.
//  - Switched off: a webhook the project had is deleted.
// Neither fails the activation or the deactivation (the hooks' contract): a failure is logged by its code; the nightly job registers or
// deletes what is left (`webhook-registrar.ts`).
import "server-only";
import type { JiraWebhooksRepository } from "../db/repositories/jira-webhooks-repository.ts";
import { jiraSourceOf } from "../db/repositories/projects-repository.ts";
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import type { TrackerRepository } from "../db/repositories/tracker-repository.ts";
import type { ProjectHooks } from "../projects/hooks.ts";
import type { JiraWebhookRegistrar } from "./webhook-registrar.ts";

export type JiraProjectHookDependencies = {
  tracker: Pick<
    TrackerRepository,
    "clearOtherProviders" | "clearJiraItemsOutside"
  >;
  projects: { getById(projectId: string): Promise<StoredProject | undefined> };
  /** The webhook row still names the connection the project had before its source changed. */
  webhooks: Pick<JiraWebhooksRepository, "getByProject">;
  registrar: Pick<JiraWebhookRegistrar, "reconcile">;
  log?: (line: string) => void;
};

const nameOf = (error: unknown) =>
  error instanceof Error ? error.name : "unknown error";

/**
 * The activation hook of a workspace's project service: Jira's part, then `next` (the first sync of the GitHub issues). `next` runs even
 * when Jira's part failed.
 */
export function createJiraActivationHook(
  deps: JiraProjectHookDependencies,
  next?: ProjectHooks["onProjectActivated"],
): NonNullable<ProjectHooks["onProjectActivated"]> {
  const log = deps.log ?? ((line) => console.error(line));
  return async (event) => {
    try {
      // A project of another provider's tickets must not carry the rows of the one it left.
      await deps.tracker.clearOtherProviders(
        event.repositoryId,
        event.ticketProvider,
      );
      const project = await deps.projects.getById(event.projectId);
      const source =
        project === undefined ? null : jiraSourceOf(project.ticketSource);
      if (source !== null) {
        // Another connection is another site: its issues share no key with these, whatever the project key.
        const before = await deps.webhooks.getByProject(event.projectId);
        const otherSite =
          before !== undefined && before.connectionId !== source.connectionId;
        await deps.tracker.clearJiraItemsOutside(
          event.repositoryId,
          otherSite ? null : source.projectKey,
        );
      }
      await deps.registrar.reconcile(event.projectId);
    } catch (error) {
      log(
        `[jira] JIRA_ACTIVATION_HOOK_FAILED: project=${event.projectId} (${nameOf(error)})`,
      );
    }
    await next?.(event);
  };
}

/** The hook after a project was switched off: deletes the webhook it had at Jira. */
export function createJiraDeactivationHook(
  deps: Pick<JiraProjectHookDependencies, "registrar" | "log">,
): NonNullable<ProjectHooks["afterProjectDeactivated"]> {
  const log = deps.log ?? ((line) => console.error(line));
  return async (event) => {
    try {
      await deps.registrar.reconcile(event.projectId);
    } catch (error) {
      log(
        `[jira] JIRA_DEACTIVATION_HOOK_FAILED: project=${event.projectId} (${nameOf(error)})`,
      );
    }
  };
}
