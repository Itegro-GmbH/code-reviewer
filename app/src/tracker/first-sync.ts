// SPDX-License-Identifier: LicenseRef-Proprietary

// What a route that creates or switches on a project does after its response (#923): the first full sync of the tickets of the repository.
// The sync reads the GitHub issues, so a project whose tickets are another provider's (a Jira project, #1038) has none: its repository is
// where the code lives, and a sync of it would only fail. The ticket mirror depends on the projects module, so the hook is handed to the
// project service by the routes and never imported there.
import type { ProjectActivatedEvent } from "../projects/hooks.ts";

export type FirstSyncDependencies = {
  /** The full sync of one repository (`TrackerService.sync`); a rejection is logged, never thrown. */
  sync(repositoryId: string, options: { deadline: number }): Promise<unknown>;
  /** Runs the work after the response (`after` of Next.js); the work never throws. */
  schedule(work: () => Promise<void>): void;
  /** How long the first sync may read before it stops and waits for the next "Resync". */
  budgetMs: number;
  now?: () => number;
  log?: (line: string) => void;
};

export function firstSyncAfterActivation({
  sync,
  schedule,
  budgetMs,
  now = Date.now,
  log = (line) => console.error(line),
}: FirstSyncDependencies): (event: ProjectActivatedEvent) => Promise<void> {
  return async ({ repositoryId, ticketProvider }) => {
    if (ticketProvider !== "github") return;
    schedule(() =>
      sync(repositoryId, { deadline: now() + budgetMs }).then(
        () => undefined,
        (error: unknown) =>
          log(
            `[tracker] the first sync of repository=${repositoryId} did not finish (${error instanceof Error ? error.name : "unknown"})`,
          ),
      ),
    );
  };
}
