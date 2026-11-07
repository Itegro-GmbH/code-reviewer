// SPDX-License-Identifier: LicenseRef-Proprietary

// Applies what a webhook delivery says to the ticket mirror (#923): one `TrackerChange` of the provider becomes a write of the cache of ONE
// workspace. The cache is a read model: a change that cannot be applied (the repository has no project, the ticket is not cached) is
// `not_mirrored` and never an error, and nothing here is the source of truth: the next full sync rebuilds what a missed delivery left
// behind. Only a repository with an active project is mirrored, the same rule that decides which repositories are reviewed.
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { TrackerRepository } from "../db/repositories/tracker-repository.ts";
import type {
  Integration,
  RepoRef,
  TrackerChange,
} from "../integrations/types.ts";

/** The provider the cache rows name; the only kind of integration there is. */
export const TRACKER_PROVIDER = "github";

export type MirrorOutcome = "updated" | "not_mirrored";

export type TrackerMirror = {
  /**
   * Writes the change. Throws what the database or the provider throws (a delivery that fails is redelivered; for a delivery that is
   * more than the mirror, the webhook handler logs the failure and goes on).
   */
  apply(
    integration: Integration,
    change: TrackerChange,
  ): Promise<MirrorOutcome>;
};

export type TrackerMirrorDependencies = {
  repositories: Pick<RepositoriesRepository, "findByExternalId">;
  projects: {
    hasActiveProject(
      integrationId: string,
      repositoryExternalId: string,
    ): Promise<boolean>;
  };
  tracker: Pick<
    TrackerRepository,
    | "upsertItem"
    | "getItem"
    | "deleteItem"
    | "setBoardStatusByNode"
    | "setParent"
    | "setChecksState"
    | "linkPullRequests"
  >;
  /** The state of the checks of a commit, as the provider names it (`readChecksState`). */
  checksStateOf(
    integration: Integration,
    repo: RepoRef,
    headSha: string,
  ): Promise<string | null>;
};

export function createTrackerMirror(
  deps: TrackerMirrorDependencies,
): TrackerMirror {
  const { tracker } = deps;

  /** The id of the repository row of a change, or undefined when the mirror does not hold this repository's tickets. */
  async function mirroredRepository(
    integration: Integration,
    repo: RepoRef,
  ): Promise<string | undefined> {
    const stored = await deps.repositories.findByExternalId(
      integration.id,
      repo.externalId,
    );
    if (stored === undefined || !stored.active) return undefined;
    if (
      !(await deps.projects.hasActiveProject(integration.id, repo.externalId))
    )
      return undefined;
    return stored.id;
  }

  return {
    async apply(integration, change) {
      // A board belongs to the organization: its item is found by the node id of its content, in whichever repository of the
      // workspace holds the ticket.
      if (change.kind === "board_status_changed")
        return (await tracker.setBoardStatusByNode(
          change.nodeId,
          change.status,
        )) > 0
          ? "updated"
          : "not_mirrored";

      const repositoryId = await mirroredRepository(integration, change.repo);
      if (repositoryId === undefined) return "not_mirrored";

      switch (change.kind) {
        case "item_changed": {
          const { item } = change;
          const before = await tracker.getItem(repositoryId, item.number);
          // A delivery older than what the cache holds (replayed, or overtaken by a newer one) changes nothing, not even the checks.
          const written = await tracker.upsertItem(repositoryId, {
            provider: TRACKER_PROVIDER,
            repo: change.repo.fullName,
            ...item,
          });
          if (!written) return "not_mirrored";
          if (item.kind === "pull_request") {
            // The checks belong to a commit: a new commit, or a pull request that is over, has none.
            if (change.resetChecks || item.state === "closed")
              await tracker.setChecksState(repositoryId, item.number, null);
            // The issues the pull request closed before and the ones it closes now list it, or do not any more.
            const affected = new Set([
              ...(before?.closes ?? []),
              ...item.closes,
            ]);
            if (affected.size > 0)
              await tracker.linkPullRequests(repositoryId, [...affected]);
          }
          return "updated";
        }
        case "item_removed":
          // The row stays as a tombstone: a delivery about the issue that is older than this one does not bring it back.
          return (await tracker.deleteItem(
            repositoryId,
            change.number,
            change.at,
          ))
            ? "updated"
            : "not_mirrored";
        case "parent_changed":
          return (await tracker.setParent(
            repositoryId,
            change.child,
            change.parent,
            change.at,
          ))
            ? "updated"
            : "not_mirrored";
        case "checks_changed": {
          let updated = false;
          let state: string | null | undefined;
          for (const number of change.pullRequests) {
            const item = await tracker.getItem(repositoryId, number);
            // Only an open pull request has checks that matter.
            if (
              item === undefined ||
              item.kind !== "pull_request" ||
              item.state !== "open"
            )
              continue;
            // One question per delivery: the suites of a commit are the same for every pull request that has it as head.
            state ??= await deps.checksStateOf(
              integration,
              change.repo,
              change.headSha,
            );
            await tracker.setChecksState(repositoryId, number, state);
            updated = true;
          }
          return updated ? "updated" : "not_mirrored";
        }
      }
    },
  };
}
