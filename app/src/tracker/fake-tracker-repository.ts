// SPDX-License-Identifier: LicenseRef-Proprietary

// An in-memory `TrackerRepository` for the unit tests of the mirror, the sync and the list (#923): the same rules as the SQL one (a ticket
// written again keeps its board status, its pull requests and its checks; a delivery older than the row is dropped; a deleted ticket stays
// as a tombstone; the pull requests of an issue are computed from the `closes` of the pull requests; rows not written since a time are
// removed; one sync is claimed at a time), without a database. The SQL itself is proved against Postgres in
// `tracker-repository.integration.test.ts`.
import {
  TOMBSTONE_KEPT_MS,
  type TrackerItem,
  type TrackerRepository,
  type TrackerSyncState,
} from "../db/repositories/tracker-repository.ts";

export type FakeTrackerRepository = TrackerRepository & {
  /** Every visible row, ordered by number. */
  rows(): TrackerItem[];
  /** The visible rows without the time of writing: what two caches are compared by. */
  snapshot(): Omit<TrackerItem, "syncedAt">[];
  /** The numbers of the tombstones (items the provider deleted), ascending. */
  tombstones(): number[];
  /** Deletes every row and the sync state, as `delete from tracker_items; delete from tracker_sync_state`. */
  clear(): void;
};

type Row = TrackerItem & {
  deletedAt: string | null;
  boardSeenAt: string | null;
};

export function createFakeTrackerRepository(
  now: () => Date = () => new Date(),
): FakeTrackerRepository {
  const items = new Map<string, Row>();
  const states = new Map<string, TrackerSyncState>();
  const key = (repositoryId: string, number: number) =>
    `${repositoryId}#${number}`;
  const stamp = () => now().toISOString();
  const rowsOf = (repositoryId: string) =>
    [...items.values()].filter(
      (item) => item.repositoryId === repositoryId && item.deletedAt === null,
    );
  const visible = (repositoryId: string, number: number) => {
    const row = items.get(key(repositoryId, number));
    return row === undefined || row.deletedAt !== null ? undefined : row;
  };
  const strip = (row: Row): TrackerItem => {
    const copy: Partial<Row> = { ...row };
    delete copy.deletedAt;
    delete copy.boardSeenAt;
    return copy as TrackerItem;
  };

  return {
    async upsertItem(repositoryId, item) {
      const before = items.get(key(repositoryId, item.number));
      if (before !== undefined) {
        // A tombstone is replaced only by a strictly newer delivery, a row by one that is not older.
        const older =
          before.deletedAt === null
            ? item.updatedAt < before.updatedAt
            : item.updatedAt <= before.updatedAt;
        if (older) {
          items.set(key(repositoryId, item.number), {
            ...before,
            syncedAt: stamp(),
          });
          return false;
        }
      }
      items.set(key(repositoryId, item.number), {
        projectId: before?.projectId ?? null,
        boardStatus: before?.boardStatus ?? null,
        boardSeenAt: before?.boardSeenAt ?? null,
        deletedAt: null,
        pullRequests: before?.pullRequests ?? [],
        checksState: before?.checksState ?? null,
        parentNumber:
          item.parentNumber === undefined
            ? (before?.parentNumber ?? null)
            : item.parentNumber,
        repositoryId,
        provider: item.provider,
        repo: item.repo,
        number: item.number,
        nodeId: item.nodeId,
        kind: item.kind,
        state: item.state,
        stateReason: item.stateReason,
        type: item.type,
        title: item.title,
        bodyExcerpt: item.bodyExcerpt,
        labels: item.labels,
        assignees: item.assignees,
        closes: item.closes,
        updatedAt: item.updatedAt,
        syncedAt: stamp(),
      });
      return true;
    },
    async getItem(repositoryId, number) {
      const row = visible(repositoryId, number);
      return row === undefined ? undefined : strip(row);
    },
    async findItemByNode(nodeId) {
      for (const item of items.values())
        if (item.nodeId === nodeId && item.deletedAt === null)
          return strip(item);
      return undefined;
    },
    async newestWriteAt(repositoryId) {
      let newest: string | null = null;
      for (const item of items.values())
        if (
          item.repositoryId === repositoryId &&
          (newest === null || item.syncedAt > newest)
        )
          newest = item.syncedAt;
      return newest;
    },
    async listItems(repositoryId, filter) {
      return rowsOf(repositoryId)
        .filter(
          (item) => filter.state === undefined || item.state === filter.state,
        )
        .filter(
          (item) => filter.kind === undefined || item.kind === filter.kind,
        )
        .sort((a, b) =>
          a.updatedAt === b.updatedAt
            ? b.number - a.number
            : a.updatedAt < b.updatedAt
              ? 1
              : -1,
        )
        .slice(filter.offset ?? 0, (filter.offset ?? 0) + filter.limit)
        .map(strip);
    },
    async deleteItem(repositoryId, number, at) {
      const row = visible(repositoryId, number);
      if (row === undefined || row.updatedAt > at) return false;
      items.set(key(repositoryId, number), {
        ...row,
        deletedAt: at,
        updatedAt: at,
        syncedAt: stamp(),
      });
      return true;
    },
    async setBoardStatusByNode(nodeId, status) {
      let changed = 0;
      for (const [id, item] of items)
        if (item.nodeId === nodeId && item.deletedAt === null) {
          items.set(id, {
            ...item,
            boardStatus: status,
            boardSeenAt: stamp(),
            syncedAt: stamp(),
          });
          changed += 1;
        }
      return changed;
    },
    async setParent(repositoryId, number, parent, at) {
      const item = visible(repositoryId, number);
      if (item === undefined || item.updatedAt > at) return false;
      items.set(key(repositoryId, number), {
        ...item,
        parentNumber: parent,
        updatedAt: at,
        syncedAt: stamp(),
      });
      return true;
    },
    async setChecksState(repositoryId, number, state) {
      const item = visible(repositoryId, number);
      if (item === undefined) return false;
      items.set(key(repositoryId, number), {
        ...item,
        checksState: state,
        syncedAt: stamp(),
      });
      return true;
    },
    async linkPullRequests(repositoryId, issueNumbers) {
      for (const issue of rowsOf(repositoryId)) {
        if (issue.kind !== "issue") continue;
        if (issueNumbers !== undefined && !issueNumbers.includes(issue.number))
          continue;
        items.set(key(repositoryId, issue.number), {
          ...issue,
          pullRequests: rowsOf(repositoryId)
            .filter(
              (pr) =>
                pr.kind === "pull_request" && pr.closes.includes(issue.number),
            )
            .map((pr) => pr.number)
            .sort((a, b) => a - b),
        });
      }
    },
    async clearBoardStatusesNotSeenSince(repositoryId, since) {
      for (const item of rowsOf(repositoryId))
        if (
          item.boardStatus !== null &&
          (item.boardSeenAt === null || item.boardSeenAt < since)
        )
          items.set(key(repositoryId, item.number), {
            ...item,
            boardStatus: null,
          });
    },
    async clearChecksStates(repositoryId) {
      for (const item of rowsOf(repositoryId))
        items.set(key(repositoryId, item.number), {
          ...item,
          checksState: null,
        });
    },
    async removeNotWrittenSince(repositoryId, before) {
      let removed = 0;
      const tombstonesBefore = new Date(
        Date.parse(before) - TOMBSTONE_KEPT_MS,
      ).toISOString();
      for (const item of items.values()) {
        if (item.repositoryId !== repositoryId) continue;
        if (item.deletedAt === null && item.syncedAt < before) {
          items.delete(key(repositoryId, item.number));
          removed += 1;
        } else if (item.deletedAt !== null && item.syncedAt < tombstonesBefore)
          items.delete(key(repositoryId, item.number));
      }
      return removed;
    },
    async getSyncState(repositoryId) {
      return states.get(repositoryId);
    },
    async claimSync(repositoryId, claim) {
      const before = states.get(repositoryId);
      const free =
        before === undefined ||
        before.cursor === null ||
        before.startedAt === null ||
        before.updatedAt < claim.staleBefore ||
        (claim.replacing !== undefined && before.cursor === claim.replacing);
      if (!free) return { claimed: false, state: before };
      const state: TrackerSyncState = {
        repositoryId,
        projectId: before?.projectId ?? null,
        cursor: claim.cursor,
        startedAt: claim.startedAt,
        lastFullSyncAt: before?.lastFullSyncAt ?? null,
        updatedAt: stamp(),
      };
      states.set(repositoryId, state);
      return { claimed: true, state };
    },
    async saveSyncState(repositoryId, state) {
      const before = states.get(repositoryId);
      states.set(repositoryId, {
        repositoryId,
        projectId: before?.projectId ?? null,
        cursor:
          state.cursor === undefined ? (before?.cursor ?? null) : state.cursor,
        startedAt:
          state.startedAt === undefined
            ? (before?.startedAt ?? null)
            : state.startedAt,
        lastFullSyncAt:
          state.lastFullSyncAt === undefined
            ? (before?.lastFullSyncAt ?? null)
            : state.lastFullSyncAt,
        updatedAt: stamp(),
      });
    },
    rows() {
      return [...items.values()]
        .filter((row) => row.deletedAt === null)
        .sort((a, b) => a.number - b.number)
        .map(strip);
    },
    snapshot() {
      return this.rows().map((row) => {
        const copy: Partial<TrackerItem> = { ...row };
        delete copy.syncedAt;
        return copy as Omit<TrackerItem, "syncedAt">;
      });
    },
    tombstones() {
      return [...items.values()]
        .filter((row) => row.deletedAt !== null)
        .map((row) => row.number)
        .sort((a, b) => a - b);
    },
    clear() {
      items.clear();
      states.clear();
    },
  };
}
