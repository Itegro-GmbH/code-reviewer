// SPDX-License-Identifier: LicenseRef-Proprietary

// The full sync of the ticket mirror (#923): reads every issue and pull request of ONE repository from the provider, then the checks of the
// open pull requests, then the status of the project boards, and writes them into the cache. It is how the cache starts (a project is
// created), how it is rebuilt (the table was lost, or a delivery was missed) and what "Resync" in the project's setup does.
//
//  - Paginated and resumable: one page of one phase at a time, and the position (`cursor`) is saved after each page. A sync that ends
//    early (the time of the request is over, GitHub did not answer) continues with the next call where it stopped; a sync that was
//    abandoned for `STALE_AFTER_MS` starts again from the beginning.
//  - The rebuild rule: when the last phase is over, the items that were not written since the sync began are gone from the provider and are
//    removed, and the pull requests that close an issue are linked again. A cache that was deleted and synced holds what a cache that was
//    kept current holds (`docs/ticket-mirror.md`).
//  - Nothing is mapped: the values are the provider's. The sync never touches anything but the cache.
import type {
  TrackerItemWrite,
  TrackerRepository,
} from "../db/repositories/tracker-repository.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import { TRACKER_PROVIDER } from "./mirror.ts";

/** A sync that has not moved for this long is abandoned and starts again. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

export type SyncPhase = "issues" | "checks" | "board";

/** Where a sync stands: the phase and the position within it. Stored as JSON text. */
export type SyncCursor =
  | { phase: "issues"; page: number }
  | { phase: "checks"; page: number }
  | { phase: "board"; after: string | null };

export type SyncProgress = {
  /** `done`: the cache is complete; `partial`: the budget ran out, call again to continue. */
  status: "done" | "partial";
  /** The phase the next call continues with; null when done. */
  next: SyncPhase | null;
  /** The items written by this call. */
  written: number;
  /** The items removed because the provider does not have them any more (only when done). */
  removed: number;
  /** False when the app may not read project boards: the board statuses are left empty. */
  boardAvailable: boolean;
};

export type TrackerSyncDependencies = {
  tracker: Pick<
    TrackerRepository,
    | "upsertItem"
    | "setBoardStatusByNode"
    | "setChecksState"
    | "linkPullRequests"
    | "clearBoardStatuses"
    | "clearChecksStates"
    | "removeNotWrittenSince"
    | "getSyncState"
    | "saveSyncState"
  >;
  provider: Pick<IntegrationProvider, "readTrackerPage">;
  now?: () => Date;
};

export type TrackerSync = {
  /**
   * Continues the sync of the repository, or starts one, and reads pages until it is done, `maxPages` pages were read or `deadline`
   * (milliseconds since the epoch) has passed. Throws what the provider throws; the position of the last page that was written is kept.
   */
  run(
    integration: Integration,
    repository: RepoRef & { id: string },
    options?: { maxPages?: number; deadline?: number; signal?: AbortSignal },
  ): Promise<SyncProgress>;
};

/** The cursor a text holds; undefined for a text that is none (a sync that cannot be continued starts again). */
export function readCursor(text: string | null): SyncCursor | undefined {
  if (text === null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const cursor = value as Record<string, unknown>;
    if (
      (cursor.phase === "issues" || cursor.phase === "checks") &&
      typeof cursor.page === "number" &&
      Number.isInteger(cursor.page) &&
      cursor.page >= 1
    )
      return { phase: cursor.phase, page: cursor.page };
    if (
      cursor.phase === "board" &&
      (cursor.after === null || typeof cursor.after === "string")
    )
      return { phase: "board", after: cursor.after };
  } catch {
    // Not JSON: no cursor.
  }
  return undefined;
}

export function createTrackerSync(deps: TrackerSyncDependencies): TrackerSync {
  const { tracker, provider } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async run(integration, repository, options = {}) {
      if (provider.readTrackerPage === undefined)
        throw new Error("The provider has no tickets to read.");
      const read = provider.readTrackerPage.bind(provider);
      const maxPages = options.maxPages ?? 50;
      const repo: RepoRef = {
        integrationId: repository.integrationId,
        externalId: repository.externalId,
        fullName: repository.fullName,
        url: repository.url,
      };

      const state = await tracker.getSyncState(repository.id);
      let cursor = readCursor(state?.cursor ?? null);
      let startedAt = state?.startedAt ?? null;
      const stale =
        startedAt === null ||
        now().getTime() - Date.parse(startedAt) > STALE_AFTER_MS;
      if (cursor === undefined || stale) {
        cursor = { phase: "issues", page: 1 };
        startedAt = now().toISOString();
        await tracker.saveSyncState(repository.id, {
          cursor: JSON.stringify(cursor),
          startedAt,
        });
      }
      const began = startedAt as string;

      let written = 0;
      let boardAvailable = true;
      let pages = 0;
      while (
        pages < maxPages &&
        (options.deadline === undefined || now().getTime() < options.deadline)
      ) {
        pages += 1;
        const page = await read(
          integration,
          repo,
          cursor.phase === "board"
            ? { phase: "board", after: cursor.after }
            : { phase: cursor.phase, page: cursor.page },
          options.signal,
        );

        let next: SyncCursor | undefined;
        if (page.phase === "issues" && cursor.phase === "issues") {
          for (const item of page.items) {
            const write: TrackerItemWrite = {
              provider: TRACKER_PROVIDER,
              repo: repo.fullName,
              ...item,
              // The list always says whether an issue has a parent: no parent is `null`, not "unknown".
              parentNumber:
                item.kind === "issue" ? (item.parentNumber ?? null) : null,
            };
            await tracker.upsertItem(repository.id, write);
          }
          written += page.items.length;
          if (!page.last) next = { phase: "issues", page: cursor.page + 1 };
          else {
            // The checks and the board statuses are read afresh: what the cache held may be out of date.
            await tracker.clearChecksStates(repository.id);
            next = { phase: "checks", page: 1 };
          }
        } else if (page.phase === "checks" && cursor.phase === "checks") {
          for (const pullRequest of page.pullRequests)
            await tracker.setChecksState(
              repository.id,
              pullRequest.number,
              pullRequest.checksState,
            );
          if (!page.last) next = { phase: "checks", page: cursor.page + 1 };
          else {
            await tracker.clearBoardStatuses(repository.id);
            next = { phase: "board", after: null };
          }
        } else if (page.phase === "board" && cursor.phase === "board") {
          boardAvailable = page.available;
          for (const item of page.items)
            await tracker.setBoardStatusByNode(item.nodeId, item.status);
          if (page.available && page.next !== null)
            next = { phase: "board", after: page.next };
        } else {
          throw new Error("The provider answered another phase than asked.");
        }

        if (next !== undefined) {
          cursor = next;
          await tracker.saveSyncState(repository.id, {
            cursor: JSON.stringify(cursor),
          });
          continue;
        }

        // The last phase is over: the rebuild rule.
        const removed = await tracker.removeNotWrittenSince(
          repository.id,
          began,
        );
        await tracker.linkPullRequests(repository.id);
        await tracker.saveSyncState(repository.id, {
          cursor: null,
          startedAt: null,
          lastFullSyncAt: now().toISOString(),
        });
        return { status: "done", next: null, written, removed, boardAvailable };
      }
      return {
        status: "partial",
        next: cursor.phase,
        written,
        removed: 0,
        boardAvailable,
      };
    },
  };
}
