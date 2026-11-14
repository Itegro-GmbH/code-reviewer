// SPDX-License-Identifier: LicenseRef-Proprietary

// What a project's switching on and off does for Jira (#1039): the routes that create, switch on or switch off a project hand these to the
// project service (the projects module may not import `jira`, so the routes wire them in, like the first sync of the ticket mirror).
//
//  - Switched on with a Jira source: the ticket mirror's rows of the other provider (the repository's GitHub issues) are cleared, so the
//    project does not show them and their numbers do not collide with the Jira rows that come in, and the webhook is registered at Jira.
//  - Switched on with a GitHub source: the Jira rows of the repository are cleared and a webhook the project had is deleted.
//  - Switched off: a webhook the project had is deleted.
// Neither fails the activation or the deactivation (the hooks' contract): a failure is logged by its code; the nightly job registers or
// deletes what is left (`webhook-registrar.ts`).
import "server-only";
import type { TrackerRepository } from "../db/repositories/tracker-repository.ts";
import type { ProjectHooks } from "../projects/hooks.ts";
import type { JiraWebhookRegistrar } from "./webhook-registrar.ts";

export type JiraProjectHookDependencies = {
  tracker: Pick<TrackerRepository, "clearOtherProviders">;
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
