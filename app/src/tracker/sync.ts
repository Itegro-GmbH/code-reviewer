// SPDX-License-Identifier: LicenseRef-Proprietary

// The full sync of the ticket mirror (#923): reads every issue and pull request of ONE repository from the provider, then the checks of the
// open pull requests, then the status of the project boards, and writes them into the cache. It is how the cache starts (a project is
// created), how it is rebuilt (the table was lost, or a delivery was missed) and what "Resync" in the project's setup does.
//
//  - Paginated and resumable: one page of one phase at a time, and the position (`cursor`) is saved after each page. A sync that ends
//    early (the time of the request is over, GitHub did not answer) continues with the next call where it stopped; a sync that has not
//    moved for `STALE_AFTER_MS` (its state is written with every page) starts again from the beginning. The nightly resync (#932) asks to
//    `resume`: its calls are a day apart, so it waits `RESUME_STALE_AFTER_MS` instead, and a repository too big for one night's slice
//    completes over several nights. Starting is one atomic claim (`claimSync`): of two calls at once one starts, the other continues the
//    sync that is there and never resets its position.
//  - The issues are read by the time of their last change, oldest first, and a list longer than one walk of pages is continued from the
//    time of the last item read (`since`), so a repository of any size ends. An item seen twice is written twice, the same.
//  - The rebuild rule: when the last phase is over, the items that were not written since the sync began are gone from the provider and are
//    removed, and the pull requests that close an issue are linked again. A cache that was deleted and synced holds what a cache that was
//    kept current holds (`docs/ticket-mirror.md`). "Since the sync began" is the start the sync state keeps, so the rows an earlier night of
//    the same sync wrote are not removed. When a ticket of the list could not be read, nothing is removed: the row of that ticket would
//    look gone.
//  - The board statuses and the checks are not emptied before they are read (a slice that ends in the middle leaves what it did not reach as
//    it was): the statuses no board said anything about are emptied at the end of the sync, and the checks of what is not an open pull
//    request at the end of the checks.
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

/** The same for a call that asks to `resume` (the nightly resync, whose calls are a day apart). */
export const RESUME_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type SyncPhase = "issues" | "checks" | "board";

/** Where a sync stands: the phase and the position within it. Stored as JSON text. */
export type SyncCursor = (
  | {
      phase: "issues";
      page: number;
      /** Where the list continues from when it is longer than one walk of pages (ISO 8601, UTC). */
      since?: string;
    }
  | { phase: "checks"; page: number }
  | { phase: "board"; after: string | null }
) & {
  /** How many tickets of the list could not be read so far (absent: none). */
  skipped?: number;
};

export type SyncProgress = {
  /** `done`: the cache is complete; `partial`: the budget ran out, call again to continue. */
  status: "done" | "partial";
  /** The phase the next call continues with; null when done. */
  next: SyncPhase | null;
  /** The items written by this call. */
  written: number;
  /** The items removed because the provider does not have them any more (only when done). */
  removed: number;
  /** The tickets of the list that could not be read in the whole sync (known when done); when there are some, nothing is removed. */
  skipped: number;
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
    | "clearBoardStatusesNotSeenSince"
    | "clearChecksStatesOfClosed"
    | "removeNotWrittenSince"
    | "getSyncState"
    | "claimSync"
    | "saveSyncState"
  >;
  provider: Pick<IntegrationProvider, "readTrackerPage">;
  now?: () => Date;
  /** Receives the line about a sync that could not remove anything. Default: console.warn. */
  warn?: (line: string) => void;
};

export type TrackerSync = {
  /**
   * Continues the sync of the repository, or starts one, and reads pages until it is done, `maxPages` pages were read or `deadline`
   * (milliseconds since the epoch) has passed. Throws what the provider throws; the position of the last page that was written is kept.
   * `resume`: an unfinished sync is continued unless it has not moved for `RESUME_STALE_AFTER_MS`, not `STALE_AFTER_MS`.
   */
  run(
    integration: Integration,
    repository: RepoRef & { id: string },
    options?: {
      maxPages?: number;
      deadline?: number;
      signal?: AbortSignal;
      resume?: boolean;
    },
  ): Promise<SyncProgress>;
};

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** The cursor a text holds; undefined for a text that is none (a sync that cannot be continued starts again). */
export function readCursor(text: string | null): SyncCursor | undefined {
  if (text === null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const cursor = value as Record<string, unknown>;
    const skipped =
      typeof cursor.skipped === "number" &&
      Number.isInteger(cursor.skipped) &&
      cursor.skipped > 0
        ? { skipped: cursor.skipped }
        : {};
    const validPage =
      typeof cursor.page === "number" &&
      Number.isInteger(cursor.page) &&
      cursor.page >= 1;
    if (cursor.phase === "issues" && validPage) {
      if (cursor.since === undefined)
        return { phase: "issues", page: cursor.page as number, ...skipped };
      if (typeof cursor.since === "string" && ISO_TIME.test(cursor.since))
        return {
          phase: "issues",
          page: cursor.page as number,
          since: cursor.since,
          ...skipped,
        };
      return undefined;
    }
    if (cursor.phase === "checks" && validPage)
      return { phase: "checks", page: cursor.page as number, ...skipped };
    if (
      cursor.phase === "board" &&
      (cursor.after === null || typeof cursor.after === "string")
    )
      return { phase: "board", after: cursor.after, ...skipped };
  } catch {
    // Not JSON: no cursor.
  }
  return undefined;
}

export function createTrackerSync(deps: TrackerSyncDependencies): TrackerSync {
  const { tracker, provider } = deps;
  const now = deps.now ?? (() => new Date());
  const warn = deps.warn ?? ((line: string) => console.warn(line));

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

      // Claim the sync: it starts here unless one is under way (a call that is reading, or one that stopped and can be continued).
      const existing = await tracker.getSyncState(repository.id);
      const unreadable =
        existing?.cursor != null && readCursor(existing.cursor) === undefined
          ? existing.cursor
          : undefined;
      const claim = await tracker.claimSync(repository.id, {
        cursor: JSON.stringify({ phase: "issues", page: 1 }),
        startedAt: now().toISOString(),
        staleBefore: new Date(
          now().getTime() -
            (options.resume === true ? RESUME_STALE_AFTER_MS : STALE_AFTER_MS),
        ).toISOString(),
        ...(unreadable === undefined ? {} : { replacing: unreadable }),
      });
      if (claim.state === undefined)
        throw new Error("The repository is not in this workspace.");
      let cursor: SyncCursor | undefined = readCursor(claim.state.cursor);
      const startedAt = claim.state.startedAt;
      if (cursor === undefined || startedAt === null)
        throw new Error("The sync state changed under way; start it again.");
      const began = startedAt;

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
            : cursor.phase === "issues"
              ? {
                  phase: "issues",
                  page: cursor.page,
                  ...(cursor.since === undefined
                    ? {}
                    : { since: cursor.since }),
                }
              : { phase: "checks", page: cursor.page },
          options.signal,
        );

        // What the sync carries from page to page besides the position.
        const carried: { skipped?: number } =
          cursor.skipped === undefined ? {} : { skipped: cursor.skipped };
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
          const skipped: number = (cursor.skipped ?? 0) + (page.skipped ?? 0);
          const skippedSoFar: { skipped?: number } =
            skipped > 0 ? { skipped } : {};
          if (!page.last) {
            // The list is ordered by the time of the last change: the next walk starts where this page ended (the item at the end is
            // read once more). When the page did not get further (many items changed in the same second) the walk goes on by page.
            const lastTime = page.items.at(-1)?.updatedAt;
            next =
              lastTime !== undefined &&
              (cursor.since === undefined || lastTime > cursor.since)
                ? { phase: "issues", page: 1, since: lastTime, ...skippedSoFar }
                : {
                    phase: "issues",
                    page: cursor.page + 1,
                    ...(cursor.since === undefined
                      ? {}
                      : { since: cursor.since }),
                    ...skippedSoFar,
                  };
          } else {
            next = { phase: "checks", page: 1, ...skippedSoFar };
          }
        } else if (page.phase === "checks" && cursor.phase === "checks") {
          for (const pullRequest of page.pullRequests)
            await tracker.setChecksState(
              repository.id,
              pullRequest.number,
              pullRequest.checksState,
            );
          if (page.last)
            // Every open pull request was read (a state the platform does not know is written as none): what is left is not one.
            await tracker.clearChecksStatesOfClosed(repository.id);
          next = page.last
            ? { phase: "board", after: null, ...carried }
            : { phase: "checks", page: cursor.page + 1, ...carried };
        } else if (page.phase === "board" && cursor.phase === "board") {
          boardAvailable = page.available;
          for (const item of page.items)
            await tracker.setBoardStatusByNode(item.nodeId, item.status);
          if (page.available && page.next !== null)
            next = { phase: "board", after: page.next, ...carried };
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

        // The last phase is over: the rebuild rule. The statuses no board said anything about since the sync began are gone.
        await tracker.clearBoardStatusesNotSeenSince(repository.id, began);
        const skipped = cursor.skipped ?? 0;
        let removed = 0;
        if (skipped > 0)
          warn(
            `[tracker] sync of repository=${repository.id}: ${skipped} ticket(s) of the list could not be read; nothing was removed from the cache`,
          );
        else
          removed = await tracker.removeNotWrittenSince(repository.id, began);
        await tracker.linkPullRequests(repository.id);
        await tracker.saveSyncState(repository.id, {
          cursor: null,
          startedAt: null,
          lastFullSyncAt: now().toISOString(),
        });
        return {
          status: "done",
          next: null,
          written,
          removed,
          skipped,
          boardAvailable,
        };
      }
      return {
        status: "partial",
        next: cursor.phase,
        written,
        removed: 0,
        skipped: cursor.skipped ?? 0,
        boardAvailable,
      };
    },
  };
}
