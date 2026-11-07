// SPDX-License-Identifier: LicenseRef-Proprietary

// An in-memory `TrackerRepository` for the unit tests of the mirror, the sync and the list (#923): the same rules as the SQL one (a ticket
// written again keeps its board status, its pull requests and its checks; the pull requests of an issue are computed from the `closes` of
// the pull requests; rows not written since a time are removed), without a database. The SQL itself is proved against Postgres in
// `tracker-repository.integration.test.ts`.
import type {
  TrackerItem,
  TrackerRepository,
  TrackerSyncState,
} from "../db/repositories/tracker-repository.ts";

export type FakeTrackerRepository = TrackerRepository & {
  /** Every row, ordered by number. */
  rows(): TrackerItem[];
  /** The rows without the time of writing: what two caches are compared by. */
  snapshot(): Omit<TrackerItem, "syncedAt">[];
  /** Deletes every row and the sync state, as `delete from tracker_items; delete from tracker_sync_state`. */
  clear(): void;
};

export function createFakeTrackerRepository(
  now: () => Date = () => new Date(),
): FakeTrackerRepository {
  const items = new Map<string, TrackerItem>();
  const states = new Map<string, TrackerSyncState>();
  const key = (repositoryId: string, number: number) =>
    `${repositoryId}#${number}`;
  const stamp = () => now().toISOString();
  const rowsOf = (repositoryId: string) =>
    [...items.values()].filter((item) => item.repositoryId === repositoryId);

  return {
    async upsertItem(repositoryId, item) {
      const before = items.get(key(repositoryId, item.number));
      items.set(key(repositoryId, item.number), {
        projectId: before?.projectId ?? null,
        boardStatus: before?.boardStatus ?? null,
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
    },
    async getItem(repositoryId, number) {
      return items.get(key(repositoryId, number));
    },
    async listItems(repositoryId, filter) {
      return rowsOf(repositoryId)
        .filter((item) => filter.state === undefined || item.state === filter.state)
        .filter((item) => filter.kind === undefined || item.kind === filter.kind)
        .sort((a, b) =>
          a.updatedAt === b.updatedAt
            ? b.number - a.number
            : a.updatedAt < b.updatedAt
              ? 1
              : -1,
        )
        .slice(filter.offset ?? 0, (filter.offset ?? 0) + filter.limit);
    },
    async deleteItem(repositoryId, number) {
      return items.delete(key(repositoryId, number));
    },
    async setBoardStatusByNode(nodeId, status) {
      let changed = 0;
      for (const [id, item] of items)
        if (item.nodeId === nodeId) {
          items.set(id, { ...item, boardStatus: status, syncedAt: stamp() });
          changed += 1;
        }
      return changed;
    },
    async setParent(repositoryId, number, parent) {
      const item = items.get(key(repositoryId, number));
      if (item === undefined) return false;
      items.set(key(repositoryId, number), {
        ...item,
        parentNumber: parent,
        syncedAt: stamp(),
      });
      return true;
    },
    async setChecksState(repositoryId, number, state) {
      const item = items.get(key(repositoryId, number));
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
              (pr) => pr.kind === "pull_request" && pr.closes.includes(issue.number),
            )
            .map((pr) => pr.number)
            .sort((a, b) => a - b),
        });
      }
    },
    async clearBoardStatuses(repositoryId) {
      for (const item of rowsOf(repositoryId))
        items.set(key(repositoryId, item.number), { ...item, boardStatus: null });
    },
    async clearChecksStates(repositoryId) {
      for (const item of rowsOf(repositoryId))
        items.set(key(repositoryId, item.number), { ...item, checksState: null });
    },
    async removeNotWrittenSince(repositoryId, before) {
      let removed = 0;
      for (const item of rowsOf(repositoryId))
        if (item.syncedAt < before) {
          items.delete(key(repositoryId, item.number));
          removed += 1;
        }
      return removed;
    },
    async getSyncState(repositoryId) {
      return states.get(repositoryId);
    },
    async saveSyncState(repositoryId, state) {
      const before = states.get(repositoryId);
      states.set(repositoryId, {
        repositoryId,
        projectId: before?.projectId ?? null,
        cursor: state.cursor === undefined ? (before?.cursor ?? null) : state.cursor,
        startedAt:
          state.startedAt === undefined ? (before?.startedAt ?? null) : state.startedAt,
        lastFullSyncAt:
          state.lastFullSyncAt === undefined
            ? (before?.lastFullSyncAt ?? null)
            : state.lastFullSyncAt,
        updatedAt: stamp(),
      });
    },
    rows() {
      return [...items.values()].sort((a, b) => a.number - b.number);
    },
    snapshot() {
      return this.rows().map(({ syncedAt: _syncedAt, ...rest }) => rest);
    },
    clear() {
      items.clear();
      states.clear();
    },
  };
}
