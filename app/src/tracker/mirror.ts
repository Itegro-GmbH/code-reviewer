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
   * Writes the change. Throws what the database or the provider throws (a delivery that fails can be redelivered by hand, GitHub does not retry it; for a delivery that is
   * more than the mirror, the webhook handler logs the failure and goes on).
   */
  apply(
    integration: Integration,
    change: TrackerChange,
  ): Promise<MirrorOutcome>;
};

export type TrackerMirrorDependencies = {
  repositories: Pick<RepositoriesRepository, "findByExternalId" | "get">;
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
    | "findItemByNode"
    | "deleteItem"
    | "setBoardStatusByNode"
    | "setParent"
    | "setChecksState"
    | "clearReviewActed"
    | "linkPullRequests"
  >;
  /**
   * The status the boards give a ticket now, by its provider id (`readBoardStatus`); `available: false` when boards cannot be read.
   * `boardId`: the board the project chose, the only one that counts (undefined: every board, the first status wins).
   */
  boardStatusOf(
    integration: Integration,
    repo: RepoRef,
    nodeId: string,
    boardId: string | undefined,
  ): Promise<{ available: boolean; status: string | null }>;
  /** The provider's id of the board the active project of the repository chose (#922, `ticket_source.board`); undefined for none. */
  boardOf(repositoryId: string): Promise<string | undefined>;
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
      if (change.kind === "board_status_changed") {
        // A project with its own board shows that board's status: another board's edit of a ticket that is on both changes nothing.
        // A delivery without `projectId` (the payload names no board) is applied on purpose: it is rare, and a status it sets is corrected by
        // the next delivery of the project's board or by the next full sync, which reads only that board (#947).
        if (change.projectId !== undefined) {
          const held = await tracker.findItemByNode(change.nodeId);
          const board =
            held === undefined
              ? undefined
              : await deps.boardOf(held.repositoryId);
          if (board !== undefined && board !== change.projectId)
            return "not_mirrored";
        }
        return (await tracker.setBoardStatusByNode(
          change.nodeId,
          change.status,
        )) > 0
          ? "updated"
          : "not_mirrored";
      }

      // The delivery names no status and the ticket may be on other boards: ask where it stands now, so that leaving one board empties the
      // status only when no other board gives one, and a ticket added or restored shows its status at once.
      if (change.kind === "board_item_reread") {
        const item = await tracker.findItemByNode(change.nodeId);
        if (item === undefined) return "not_mirrored";
        const stored = await deps.repositories.get(item.repositoryId);
        if (stored === undefined || stored.integrationId !== integration.id)
          return "not_mirrored";
        const repo: RepoRef = {
          integrationId: stored.integrationId,
          externalId: stored.externalId,
          fullName: stored.fullName,
          url: stored.url,
        };
        if ((await mirroredRepository(integration, repo)) === undefined)
          return "not_mirrored";
        // The project's board decides the status; a delivery about another board says nothing about it.
        const board = await deps.boardOf(item.repositoryId);
        if (
          board !== undefined &&
          change.projectId !== undefined &&
          change.projectId !== board
        )
          return "not_mirrored";
        const read = await deps.boardStatusOf(
          integration,
          repo,
          change.nodeId,
          board,
        );
        // Boards that cannot be read: a ticket that left its board has no status, any other change says nothing.
        if (!read.available && !change.removed) return "not_mirrored";
        return (await tracker.setBoardStatusByNode(
          change.nodeId,
          read.available ? read.status : null,
        )) > 0
          ? "updated"
          : "not_mirrored";
      }

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
            if (change.resetChecks || item.state === "closed") {
              await tracker.setChecksState(repositoryId, item.number, null);
              // #924: a person who acted on a review ToDo did so for the commit that was the head; a request that stands is for the new one.
              await tracker.clearReviewActed(repositoryId, item.number);
            }
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
