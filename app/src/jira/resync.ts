// SPDX-License-Identifier: LicenseRef-Proprietary

// The full read of a Jira project into the ticket mirror (#1040): the first read when a project is set up on a Jira project (the webhook only
// brings what changes after it is registered), the nightly resync and the "Resync" button. The same shape as the sync of GitHub's issues
// (`src/tracker/sync.ts`) and with the same rules, made smaller because Jira has no board and no checks:
//
//  - Paged and resumable: one page of the JQL search `project = "KEY"` at a time, and the position (Jira's `nextPageToken`) is saved after each
//    page in the sync state of provider `jira`. A call that ends early (its deadline, its page limit, Jira did not answer) continues with the
//    next call where it stopped; a sync that has not moved for `STALE_AFTER_MS` starts again from the first page; the nightly resync asks to
//    `resume` and waits `RESUME_STALE_AFTER_MS` instead.
//  - The rebuild rule: when the last page is read, the rows that were not written since the sync began are gone from Jira (deleted, or moved
//    to another project) and are removed. When an entry of a page could not be read, nothing is removed (its row would look gone).
//  - Every issue goes into the mirror the way a delivery does (`mirror.ts`, newest change wins), so a delivery that arrives meanwhile is never
//    overwritten by an older read.
// Throws what the search cannot do (a code, never a body); the position of the last page that was written is kept.
import type {
  TrackerRepository,
  TrackerSyncState,
} from "../db/repositories/tracker-repository.ts";
import type { JiraIssueSearch } from "./issue-search.ts";
import type { JiraMirror, JiraMirrorTarget } from "./mirror.ts";

export const JIRA_SYNC_PROVIDER = "jira";

/** A sync that has not moved for this long is abandoned and starts again. */
export const STALE_AFTER_MS = 60 * 60 * 1000;
/** The same for a call that asks to `resume` (the nightly resync, whose calls are a day apart). */
export const RESUME_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** The most pages one sync reads in one call when the caller names no limit: 200 pages are 20 000 issues. */
export const MAX_PAGES_PER_CALL = 200;

export type JiraSyncProgress = {
  status: "done" | "partial";
  next: "issues" | null;
  written: number;
  removed: number;
  skipped: number;
  boardAvailable: false;
};

/** A failure of the read, with the stable code of Jira's answer (never its text). */
export class JiraSyncError extends Error {
  readonly code: string;
  readonly providerCode: string;

  constructor(code: string) {
    super(`The Jira project could not be read (${code}).`);
    this.name = "JiraSyncError";
    this.code = code;
    this.providerCode = code;
  }
}

export type JiraResyncTarget = JiraMirrorTarget & {
  connectionId: string;
  projectKey: string;
};

export type JiraResync = {
  run(
    target: JiraResyncTarget,
    options?: {
      maxPages?: number;
      deadline?: number;
      signal?: AbortSignal;
      resume?: boolean;
    },
  ): Promise<JiraSyncProgress>;
};

type Cursor = { after?: string; skipped: number };

function readCursor(text: string | null): Cursor | undefined {
  if (text === null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const { after, skipped } = value as Record<string, unknown>;
    if (after !== undefined && typeof after !== "string") return undefined;
    return {
      ...(after === undefined ? {} : { after }),
      skipped:
        typeof skipped === "number" && Number.isInteger(skipped) && skipped > 0
          ? skipped
          : 0,
    };
  } catch {
    return undefined;
  }
}

export function createJiraResync(deps: {
  tracker: Pick<
    TrackerRepository,
    "getSyncState" | "saveSyncState" | "removeNotWrittenSince"
  >;
  search: JiraIssueSearch;
  mirror: JiraMirror;
  now?: () => Date;
  warn?: (line: string) => void;
}): JiraResync {
  const now = deps.now ?? (() => new Date());
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const { tracker } = deps;

  /** The cursor and start to continue, or undefined when a new sync starts. */
  function continuing(
    state: TrackerSyncState | undefined,
    resume: boolean,
  ): { cursor: Cursor; startedAt: string } | undefined {
    if (state === undefined || state.startedAt === null) return undefined;
    const cursor = readCursor(state.cursor);
    if (cursor === undefined) return undefined;
    const idle = now().getTime() - Date.parse(state.updatedAt);
    if (
      Number.isNaN(idle) ||
      idle >= (resume ? RESUME_STALE_AFTER_MS : STALE_AFTER_MS)
    )
      return undefined;
    return { cursor, startedAt: state.startedAt };
  }

  return {
    async run(target, options = {}) {
      const { repositoryId } = target;
      const maxPages = options.maxPages ?? MAX_PAGES_PER_CALL;
      const state = await tracker.getSyncState(
        repositoryId,
        JIRA_SYNC_PROVIDER,
      );
      const resumed = continuing(state, options.resume === true);
      let cursor: Cursor = resumed?.cursor ?? { skipped: 0 };
      const startedAt = resumed?.startedAt ?? now().toISOString();
      if (resumed === undefined)
        await tracker.saveSyncState(
          repositoryId,
          { cursor: JSON.stringify(cursor), startedAt },
          JIRA_SYNC_PROVIDER,
        );

      let written = 0;
      for (let pages = 0; pages < maxPages; pages += 1) {
        if (options.signal?.aborted === true) break;
        if (
          options.deadline !== undefined &&
          now().getTime() >= options.deadline
        )
          break;
        const page = await deps.search.page(
          target.connectionId,
          target.projectKey,
          cursor.after,
          options.signal,
        );
        if (!page.ok) throw new JiraSyncError(page.error);
        for (const issue of page.issues)
          if (
            (await deps.mirror.apply(target, {
              kind: "issue_changed",
              event: "updated",
              issue,
              matchedWebhookIds: [],
            })) === "updated"
          )
            written += 1;
        const skipped = cursor.skipped + page.skipped;
        if (page.next !== undefined) {
          cursor = { after: page.next, skipped };
          await tracker.saveSyncState(
            repositoryId,
            { cursor: JSON.stringify(cursor) },
            JIRA_SYNC_PROVIDER,
          );
          continue;
        }
        // The last page: what Jira no longer has is removed, unless an entry could not be read (nothing is removed then).
        let removed = 0;
        if (skipped === 0)
          removed = await tracker.removeNotWrittenSince(
            repositoryId,
            startedAt,
            JIRA_SYNC_PROVIDER,
          );
        else
          warn(
            `[jira] the full read of repository=${repositoryId} could not read ${String(skipped)} issue(s): nothing was removed.`,
          );
        await tracker.saveSyncState(
          repositoryId,
          {
            cursor: null,
            startedAt: null,
            lastFullSyncAt: now().toISOString(),
          },
          JIRA_SYNC_PROVIDER,
        );
        return {
          status: "done",
          next: null,
          written,
          removed,
          skipped,
          boardAvailable: false,
        };
      }
      return {
        status: "partial",
        next: "issues",
        written,
        removed: 0,
        skipped: cursor.skipped,
        boardAvailable: false,
      };
    },
  };
}
