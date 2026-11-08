// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the ticket mirror of ONE workspace (#923; the factory takes the workspace id, see ../workspace-scope.ts): `tracker_items`, the
// read cache of the issues and pull requests of a repository, and `tracker_sync_state`, where a full sync stands. The only code that
// reads or writes them. The cache is rebuilt from the provider at any time and is never the source of truth (`src/tracker/README.md`):
// nothing here decides what a value means, the values are stored as the provider delivers them.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import {
  decodeJson,
  encodeJson,
  formatTimestamp,
  tryDecodeJson,
} from "../codecs.ts";
import type {
  Database,
  TrackerItemsTable,
  TrackerSyncStateTable,
} from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type TrackerItemKind = "issue" | "pull_request";
export type TrackerItemState = "open" | "closed";

export type TrackerLabel = { name: string; color: string };
export type TrackerAssignee = { login: string };

/** One person who acted on a review ToDo, and the head commit of the pull request at that time. */
export type ReviewMark = { login: string; sha: string };

/** How many marks a row keeps (the oldest go first): the column holds at most 4096 characters. */
export const REVIEW_MARKS_MAX = 25;

/** The marks with this login added (a mark of the same login, compared without regard to case, is replaced). */
export function withReviewMark(
  marks: readonly ReviewMark[],
  login: string,
  sha: string,
): ReviewMark[] {
  const others = marks.filter(
    (mark) => mark.login.toLowerCase() !== login.toLowerCase(),
  );
  return [...others, { login, sha }].slice(-REVIEW_MARKS_MAX);
}

/** The marks that are still valid: when nobody is asked there are none, and a head commit says which ones were made for it. */
export function liveReviewMarks(
  marks: readonly ReviewMark[],
  asked: readonly string[] | undefined,
  headSha: string | undefined,
): ReviewMark[] {
  if (asked !== undefined && asked.length === 0) return [];
  return headSha === undefined
    ? [...marks]
    : marks.filter((mark) => mark.sha === headSha);
}

/** A cached issue or pull request. */
export type TrackerItem = {
  repositoryId: string;
  /** Reserved for #922; null until a project is the ticket source. */
  projectId: string | null;
  provider: string;
  /** "owner/name". */
  repo: string;
  number: number;
  nodeId: string;
  kind: TrackerItemKind;
  state: TrackerItemState;
  stateReason: string | null;
  type: string | null;
  title: string;
  bodyExcerpt: string;
  labels: TrackerLabel[];
  assignees: TrackerAssignee[];
  boardStatus: string | null;
  parentNumber: number | null;
  /** The numbers of the pull requests that close the issue. */
  pullRequests: number[];
  /** The numbers of the issues the pull request closes. */
  closes: number[];
  checksState: string | null;
  /** #924: the logins a review of the pull request is asked from (the provider's `requested_reviewers`); empty for an issue and for none. */
  reviewRequestedFrom: string[];
  /**
   * #924: who acted on the review ToDo of the pull request, and for which head commit, while the provider still holds a request that
   * covers them (their own, or the fan-out's: a member that is not asked by name is marked all the same); the list hides the review from
   * them. A mark goes with a new head commit, with the end of the pull request, and when nobody is asked any more, never because its login
   * is not in a list of the people asked.
   */
  reviewActedBy: ReviewMark[];
  /** The provider's time of the last change. */
  updatedAt: string;
  /** When the row was last written from the provider. */
  syncedAt: string;
};

/**
 * What a delivery or a page of the provider says about one item. The board status, the pull requests of an issue and the checks of a pull
 * request are not part of it: they come from other deliveries and keep their value when an item is written again.
 */
export type TrackerItemWrite = Pick<
  TrackerItem,
  | "provider"
  | "repo"
  | "number"
  | "nodeId"
  | "kind"
  | "state"
  | "stateReason"
  | "type"
  | "title"
  | "bodyExcerpt"
  | "labels"
  | "assignees"
  | "closes"
  | "updatedAt"
> & {
  /**
   * The parent issue, or null for none; `undefined` leaves what the row has (a payload that does not carry the field says nothing about
   * it).
   */
  parentNumber?: number | null;
  /**
   * #924: who a review of the pull request is asked from; `undefined` leaves what the row has (an issue, a comment event and the list of
   * the issues say nothing about it).
   */
  reviewRequestedFrom?: string[];
};

export type TrackerItemFilter = {
  /** Left out: both. */
  state?: TrackerItemState;
  kind?: TrackerItemKind;
  /** The most items answered (the newest change first). */
  limit: number;
  /** How many of the newest to leave out. */
  offset?: number;
};

/** Where the full sync of a repository stands. */
export type TrackerSyncState = {
  repositoryId: string;
  projectId: string | null;
  /** JSON text: the phase under way and its position; null when no sync is under way. */
  cursor: string | null;
  /** When the sync under way began. */
  startedAt: string | null;
  lastFullSyncAt: string | null;
  updatedAt: string;
};

/** How long a tombstone (an item the provider deleted) is kept after the last time it was written: long enough for a late delivery. */
export const TOMBSTONE_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

export type TrackerRepository = {
  /**
   * Writes the item: inserts it, or replaces what the provider says of it. Board status, pull requests and checks stay as they are.
   * A delivery older than what the row holds (`updatedAt`; a tombstone is only replaced by a strictly newer one) is dropped, so a replayed
   * or late delivery cannot undo a newer one. Either way the row counts as written (`syncedAt`). Answers whether the row now holds this
   * delivery; false for a stale one and for a repository that is not in the workspace.
   */
  upsertItem(repositoryId: string, item: TrackerItemWrite): Promise<boolean>;
  getItem(
    repositoryId: string,
    number: number,
  ): Promise<TrackerItem | undefined>;
  /** The cached item the provider's id names, in any repository of the workspace; undefined for none and for a tombstone. */
  findItemByNode(nodeId: string): Promise<TrackerItem | undefined>;
  /**
   * When the cache of the repository was last written (the newest `syncedAt` of its rows, a tombstone included): by a delivery or by a
   * sync. After the end of a full sync (`lastFullSyncAt`) it says whether a delivery has arrived since; null for no row.
   */
  newestWriteAt(repositoryId: string): Promise<string | null>;
  /** The items of the repository, the newest change first. */
  listItems(
    repositoryId: string,
    filter: TrackerItemFilter,
  ): Promise<TrackerItem[]>;
  /**
   * Hides the item as of `at` (the provider's time of the deletion): the row stays as a tombstone, so a delivery older than `at` does not
   * bring it back. Answers whether a visible item was hidden; false when there is none, or it changed after `at`.
   */
  deleteItem(
    repositoryId: string,
    number: number,
    at: string,
  ): Promise<boolean>;
  /**
   * Sets the board status of the item the board names by its node id (any repository of the workspace) and notes that a board saw it;
   * answers how many rows changed.
   */
  setBoardStatusByNode(nodeId: string, status: string | null): Promise<number>;
  /**
   * Sets the parent of an issue as of `at` (the provider's time of the change, the same clock as `updatedAt`); answers whether the issue is
   * cached and was not changed after `at`.
   */
  setParent(
    repositoryId: string,
    number: number,
    parent: number | null,
    at: string,
  ): Promise<boolean>;
  setChecksState(
    repositoryId: string,
    number: number,
    state: string | null,
  ): Promise<boolean>;
  /**
   * #924: who a review of the pull request is asked from (the full sync reads it from the list of the open pull requests), as of `at`,
   * the provider's time of the pull request in that list: a pull request a delivery changed after `at` keeps what the delivery said,
   * like `upsertItem`. Answers whether the row was written.
   */
  setReviewRequestedFrom(
    repositoryId: string,
    number: number,
    logins: readonly string[] | undefined,
    at: string,
    headSha?: string,
  ): Promise<boolean>;
  /**
   * #924: takes one login (compared without regard to case) out of who a review is asked from, right after its request was taken away,
   * and marks that it acted for the commit `sha`, so that a delivery that still lists it does not bring the ToDo back. The row's time
   * stays: GitHub tells seconds only, and a change of the same second must still be taken (the mark, not the time, keeps a stale list
   * of that second from bringing the ToDo back).
   */
  removeReviewRequested(
    repositoryId: string,
    number: number,
    login: string,
    sha: string,
  ): Promise<boolean>;
  /** #924: remembers that this login acted on the review ToDo of the pull request, which had the head commit `sha`. */
  markReviewActed(
    repositoryId: string,
    number: number,
    login: string,
    sha: string,
  ): Promise<boolean>;
  /** #954: forgets that this login (compared without regard to case) acted: it is asked for a review again for the same commit. */
  forgetReviewActed(
    repositoryId: string,
    number: number,
    login: string,
  ): Promise<boolean>;
  /** #924: forgets who acted: the pull request has a new commit, so a request that stands is for that commit. */
  clearReviewActed(repositoryId: string, number: number): Promise<boolean>;
  /** #924: the items of the repository with these numbers (at most 200 are looked at), in no particular order. */
  listItemsByNumbers(
    repositoryId: string,
    numbers: readonly number[],
  ): Promise<TrackerItem[]>;
  /**
   * Computes `pullRequests` again for these issues (all issues of the repository when none are named) from the `closes` of the cached
   * pull requests: an issue lists the pull requests that close it.
   */
  linkPullRequests(
    repositoryId: string,
    issueNumbers?: readonly number[],
  ): Promise<void>;
  /** Empties the board status of the items no board said anything about since `since` (the end of a full sync of the boards). */
  clearBoardStatusesNotSeenSince(
    repositoryId: string,
    since: string,
  ): Promise<void>;
  /**
   * Forgets the checks of every row that is not an open pull request (the end of a full sync of the checks: every open pull request was
   * read, and a state the platform does not know was written as none).
   */
  clearChecksStatesOfClosed(repositoryId: string): Promise<void>;
  /**
   * Removes the items not written since `before`; answers how many. Tombstones go only when they were written last more than
   * `TOMBSTONE_KEPT_MS` before `before`.
   */
  removeNotWrittenSince(repositoryId: string, before: string): Promise<number>;
  getSyncState(repositoryId: string): Promise<TrackerSyncState | undefined>;
  /**
   * Starts a sync in one atomic step, unless one is under way: the state is written (this cursor and start, nothing else changes) only
   * when the repository has no sync, the last one ended, it has not moved since `staleBefore` (its `updatedAt` is bumped with every
   * page) or its cursor is the unreadable text `replacing`. Otherwise another call owns the sync and its state is left alone.
   * `claimed` says which; `state` is what the row holds afterwards (undefined for a repository that is not in the workspace).
   */
  claimSync(
    repositoryId: string,
    claim: {
      cursor: string;
      startedAt: string;
      staleBefore: string;
      replacing?: string;
    },
  ): Promise<{ claimed: boolean; state: TrackerSyncState | undefined }>;
  /** Writes the state of the sync of the repository; fields left out keep their value. */
  saveSyncState(
    repositoryId: string,
    state: {
      cursor?: string | null;
      startedAt?: string | null;
      lastFullSyncAt?: string | null;
    },
  ): Promise<void>;
};

function itemFrom(row: Selectable<TrackerItemsTable>): TrackerItem {
  return {
    repositoryId: row.repository_id,
    projectId: row.project_id,
    provider: row.provider,
    repo: row.repo,
    number: row.number,
    nodeId: row.node_id,
    kind: row.kind as TrackerItemKind,
    state: row.state as TrackerItemState,
    stateReason: row.state_reason,
    type: row.type,
    title: row.title,
    bodyExcerpt: row.body_excerpt,
    labels: decodeJson<TrackerLabel[]>(row.labels),
    assignees: decodeJson<TrackerAssignee[]>(row.assignees),
    boardStatus: row.board_status,
    parentNumber: row.parent_number,
    pullRequests: decodeJson<number[]>(row.pull_requests),
    closes: decodeJson<number[]>(row.closes),
    checksState: row.checks_state,
    reviewRequestedFrom: loginsFrom(row.review_requested_from),
    reviewActedBy: marksFrom(row.review_acted_by),
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

/** The logins of the column: null and a text that is no list of texts read as nobody. */
function loginsFrom(text: string | null): string[] {
  if (text === null) return [];
  const decoded = tryDecodeJson<unknown>(text);
  return decoded.ok && Array.isArray(decoded.value)
    ? decoded.value.filter(
        (login): login is string => typeof login === "string",
      )
    : [];
}

/** The marks of the column: null and a text that is no list of `{login, sha}` read as none (a bare login has no commit, so no sha). */
function marksFrom(text: string | null): ReviewMark[] {
  if (text === null) return [];
  const decoded = tryDecodeJson<unknown>(text);
  if (!decoded.ok || !Array.isArray(decoded.value)) return [];
  return decoded.value.flatMap((entry: unknown): ReviewMark[] => {
    if (typeof entry === "string") return [{ login: entry, sha: "" }];
    if (typeof entry !== "object" || entry === null) return [];
    const { login, sha } = entry as { login?: unknown; sha?: unknown };
    return typeof login === "string"
      ? [{ login, sha: typeof sha === "string" ? sha : "" }]
      : [];
  });
}

function syncStateFrom(
  row: Selectable<TrackerSyncStateTable>,
): TrackerSyncState {
  return {
    repositoryId: row.repository_id,
    projectId: row.project_id,
    cursor: row.cursor,
    startedAt: row.started_at,
    lastFullSyncAt: row.last_full_sync_at,
    updatedAt: row.updated_at,
  };
}

/** The two lists of a pull request, and the time of the row, as `changeReviewLists` hands them over. `requested` null: never told. */
type ReviewLists = {
  requested: string[] | null;
  acted: ReviewMark[];
  updatedAt: string;
};

export function createTrackerRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  options: { now?: () => Date } = {},
): TrackerRepository {
  const now = options.now ?? (() => new Date());
  const own = (repositoryId: string, number: number) =>
    db
      .updateTable("tracker_items")
      .where("workspace_id", "=", workspaceId)
      .where("repository_id", "=", repositoryId)
      .where("number", "=", number);

  /**
   * Changes the lists of a pull request in one transaction, with the row locked, so that two members acting at once, or an action and a
   * delivery, do not lose each other's change. `change` answers the new lists, or undefined to leave the row as it is.
   */
  const changeReviewLists = async (
    repositoryId: string,
    number: number,
    change: (lists: ReviewLists) => ReviewLists | undefined,
  ): Promise<boolean> => {
    const run = async (executor: Kysely<Database>): Promise<boolean> => {
      const row = await executor
        .selectFrom("tracker_items")
        .select(["review_requested_from", "review_acted_by", "updated_at"])
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("number", "=", number)
        .where("deleted_at", "is", null)
        .where("kind", "=", "pull_request")
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return false;
      const next = change({
        requested:
          row.review_requested_from === null
            ? null
            : loginsFrom(row.review_requested_from),
        acted: marksFrom(row.review_acted_by),
        updatedAt: row.updated_at,
      });
      if (next === undefined) return false;
      await executor
        .updateTable("tracker_items")
        .set({
          review_requested_from:
            next.requested === null ? null : encodeJson(next.requested),
          review_acted_by:
            next.acted.length === 0 ? null : encodeJson(next.acted),
          updated_at: next.updatedAt,
          synced_at: formatTimestamp(now()),
        })
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("number", "=", number)
        .execute();
      return true;
    };
    return db.isTransaction ? run(db) : db.transaction().execute(run);
  };

  const getSyncState: TrackerRepository["getSyncState"] = async (
    repositoryId,
  ) => {
    const row = await db
      .selectFrom("tracker_sync_state")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("repository_id", "=", repositoryId)
      .executeTakeFirst();
    return row === undefined ? undefined : syncStateFrom(row);
  };

  return {
    async upsertItem(repositoryId, item) {
      const at = formatTimestamp(now());
      // What other deliveries fill in is empty for a ticket seen for the first time and kept when it is written again. The values are
      // selected from `repositories`, so nothing is inserted for a repository that is not in the workspace; the parameters are cast
      // because a select list does not tell Postgres their type.
      const parent =
        item.parentNumber === undefined
          ? sql`tracker_items.parent_number`
          : sql`excluded.parent_number`;
      const requested =
        item.reviewRequestedFrom === undefined
          ? sql`tracker_items.review_requested_from`
          : sql`excluded.review_requested_from`;
      // The marks stay with the row: a list of the people asked that lacks a login says nothing against its mark (a member of the fan-out
      // is never asked by name). They go when nobody is asked (a later request is a new ToDo) by a delivery newer than the row: an empty
      // list of the same second (GitHub's answer to our own removal) keeps them, so a stale list of that second cannot bring the review
      // back. A new commit clears them on its own. Decided in this statement, so no read comes before the write.
      const acted =
        item.reviewRequestedFrom?.length === 0
          ? sql`case when excluded.updated_at > tracker_items.updated_at then null else tracker_items.review_acted_by end`
          : sql`tracker_items.review_acted_by`;
      const written = await sql<{ number: number }>`insert into tracker_items (
          workspace_id, repository_id, project_id, provider, repo, number, node_id, kind, state, state_reason, type, title,
          body_excerpt, labels, assignees, board_status, parent_number, pull_requests, closes, checks_state, updated_at, synced_at,
          deleted_at, board_seen_at, review_requested_from
        )
        select r.workspace_id, r.id, (select p.id from projects p where p.repository_id = r.id), ${item.provider}::text, ${item.repo}::text, ${item.number}::integer, ${item.nodeId}::text,
          ${item.kind}::text, ${item.state}::text, ${item.stateReason}::text, ${item.type}::text, ${item.title}::text,
          ${item.bodyExcerpt}::text, ${encodeJson(item.labels)}::text, ${encodeJson(item.assignees)}::text, null,
          ${item.parentNumber ?? null}::integer, '[]', ${encodeJson(item.closes)}::text, null, ${item.updatedAt}::text, ${at}::text,
          null, null, ${item.reviewRequestedFrom === undefined ? null : encodeJson(item.reviewRequestedFrom)}::text
        from repositories r
        where r.id = ${repositoryId} and r.workspace_id = ${workspaceId}
        on conflict (repository_id, number) do update set
          project_id = coalesce(excluded.project_id, tracker_items.project_id),
          provider = excluded.provider,
          repo = excluded.repo,
          node_id = excluded.node_id,
          kind = excluded.kind,
          state = excluded.state,
          state_reason = excluded.state_reason,
          type = excluded.type,
          title = excluded.title,
          body_excerpt = excluded.body_excerpt,
          labels = excluded.labels,
          assignees = excluded.assignees,
          closes = excluded.closes,
          parent_number = ${parent},
          review_requested_from = ${requested},
          review_acted_by = ${acted},
          updated_at = excluded.updated_at,
          synced_at = excluded.synced_at,
          deleted_at = null
        where tracker_items.workspace_id = ${workspaceId}
          and case
            when tracker_items.deleted_at is null then excluded.updated_at >= tracker_items.updated_at
            else excluded.updated_at > tracker_items.updated_at
          end
        returning tracker_items.number`.execute(db);
      if (written.rows.length > 0) return true;
      // A delivery older than the row (or a repository that is not ours): nothing is replaced, but the row was seen, so a full sync
      // that is reading keeps it.
      await own(repositoryId, item.number).set({ synced_at: at }).execute();
      return false;
    },

    async getItem(repositoryId, number) {
      const row = await db
        .selectFrom("tracker_items")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("number", "=", number)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return row === undefined ? undefined : itemFrom(row);
    },

    async findItemByNode(nodeId) {
      const row = await db
        .selectFrom("tracker_items")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("node_id", "=", nodeId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return row === undefined ? undefined : itemFrom(row);
    },

    async newestWriteAt(repositoryId) {
      const row = await db
        .selectFrom("tracker_items")
        .select((eb) => eb.fn.max("synced_at").as("newest"))
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .executeTakeFirst();
      return row?.newest ?? null;
    },

    async listItems(repositoryId, filter) {
      let query = db
        .selectFrom("tracker_items")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("deleted_at", "is", null);
      if (filter.state !== undefined)
        query = query.where("state", "=", filter.state);
      if (filter.kind !== undefined)
        query = query.where("kind", "=", filter.kind);
      const rows = await query
        .orderBy("updated_at", "desc")
        .orderBy("number", "desc")
        .limit(filter.limit)
        .offset(filter.offset ?? 0)
        .execute();
      return rows.map(itemFrom);
    },

    async deleteItem(repositoryId, number, at) {
      const result = await own(repositoryId, number)
        .set({
          deleted_at: at,
          updated_at: at,
          synced_at: formatTimestamp(now()),
        })
        .where("deleted_at", "is", null)
        .where("updated_at", "<=", at)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async setBoardStatusByNode(nodeId, status) {
      const at = formatTimestamp(now());
      const result = await db
        .updateTable("tracker_items")
        .set({ board_status: status, board_seen_at: at, synced_at: at })
        .where("workspace_id", "=", workspaceId)
        .where("node_id", "=", nodeId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async setParent(repositoryId, number, parent, at) {
      const result = await own(repositoryId, number)
        .set({
          parent_number: parent,
          updated_at: at,
          synced_at: formatTimestamp(now()),
        })
        .where("deleted_at", "is", null)
        .where("updated_at", "<=", at)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async setChecksState(repositoryId, number, state) {
      const result = await own(repositoryId, number)
        .set({ checks_state: state, synced_at: formatTimestamp(now()) })
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    setReviewRequestedFrom(repositoryId, number, logins, at, headSha) {
      return changeReviewLists(repositoryId, number, (lists) =>
        // A pull request a delivery changed after the list was read keeps what the delivery said.
        lists.updatedAt > at
          ? undefined
          : {
              requested: logins === undefined ? lists.requested : [...logins],
              acted: liveReviewMarks(lists.acted, logins, headSha),
              updatedAt: lists.updatedAt,
            },
      );
    },

    removeReviewRequested(repositoryId, number, login, sha) {
      return changeReviewLists(repositoryId, number, (lists) => ({
        requested: (lists.requested ?? []).filter(
          (other) => other.toLowerCase() !== login.toLowerCase(),
        ),
        acted: withReviewMark(lists.acted, login, sha),
        updatedAt: lists.updatedAt,
      }));
    },

    forgetReviewActed(repositoryId, number, login) {
      return changeReviewLists(repositoryId, number, (lists) => {
        const acted = lists.acted.filter(
          (mark) => mark.login.toLowerCase() !== login.toLowerCase(),
        );
        return acted.length === lists.acted.length
          ? undefined
          : { requested: lists.requested, acted, updatedAt: lists.updatedAt };
      });
    },

    markReviewActed(repositoryId, number, login, sha) {
      return changeReviewLists(repositoryId, number, (lists) => ({
        requested: lists.requested,
        acted: withReviewMark(lists.acted, login, sha),
        updatedAt: lists.updatedAt,
      }));
    },

    async clearReviewActed(repositoryId, number) {
      const result = await own(repositoryId, number)
        .set({ review_acted_by: null })
        .where("deleted_at", "is", null)
        .where("review_acted_by", "is not", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async listItemsByNumbers(repositoryId, numbers) {
      if (numbers.length === 0) return [];
      const rows = await db
        .selectFrom("tracker_items")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("deleted_at", "is", null)
        .where("number", "in", numbers.slice(0, 200))
        .execute();
      return rows.map(itemFrom);
    },

    async linkPullRequests(repositoryId, issueNumbers) {
      if (issueNumbers?.length === 0) return;
      const only =
        issueNumbers === undefined
          ? sql``
          : sql`and t.number in (${sql.join(issueNumbers.map((number) => sql.lit(number)))})`;
      // One pass: the `closes` of every pull request are unnested once and gathered per issue number, then joined to the issues.
      // (`closes` is JSON text written by `upsertItem`; the cast reads it as such.) An issue no pull request closes gets `[]`;
      // a row that already holds the right text is not written.
      await sql`with closing as materialized (
          select c.value::integer as issue_number, jsonb_agg(distinct p.number order by p.number)::text as numbers
          from tracker_items p
          cross join lateral jsonb_array_elements_text(p.closes::jsonb) as c(value)
          where p.workspace_id = ${workspaceId}
            and p.repository_id = ${repositoryId}
            and p.kind = 'pull_request'
            and p.deleted_at is null
            and p.closes <> '[]'
          group by c.value::integer
        )
        update tracker_items i
        set pull_requests = coalesce(closing.numbers, '[]')
        from tracker_items t
        left join closing on closing.issue_number = t.number
        where t.workspace_id = ${workspaceId}
          and t.repository_id = ${repositoryId}
          and t.kind = 'issue'
          and t.deleted_at is null
          ${only}
          and i.repository_id = t.repository_id
          and i.number = t.number
          and i.pull_requests is distinct from coalesce(closing.numbers, '[]')`.execute(
        db,
      );
    },

    async clearBoardStatusesNotSeenSince(repositoryId, since) {
      await db
        .updateTable("tracker_items")
        .set({ board_status: null })
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("board_status", "is not", null)
        .where((eb) =>
          eb.or([
            eb("board_seen_at", "is", null),
            eb("board_seen_at", "<", since),
          ]),
        )
        .execute();
    },

    async clearChecksStatesOfClosed(repositoryId) {
      await db
        .updateTable("tracker_items")
        .set({ checks_state: null })
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("checks_state", "is not", null)
        .where((eb) =>
          eb.or([eb("kind", "<>", "pull_request"), eb("state", "<>", "open")]),
        )
        .execute();
    },

    async removeNotWrittenSince(repositoryId, before) {
      const result = await db
        .deleteFrom("tracker_items")
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("synced_at", "<", before)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      // A tombstone is not counted: it is an item that was already gone. It stays for a while for the deliveries that come late.
      await db
        .deleteFrom("tracker_items")
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("deleted_at", "is not", null)
        .where(
          "synced_at",
          "<",
          formatTimestamp(new Date(Date.parse(before) - TOMBSTONE_KEPT_MS)),
        )
        .execute();
      return Number(result.numDeletedRows);
    },

    getSyncState,

    async claimSync(repositoryId, claim) {
      const at = formatTimestamp(now());
      const replacing =
        claim.replacing === undefined
          ? sql``
          : sql`or tracker_sync_state."cursor" = ${claim.replacing}`;
      // One statement: Postgres locks the row of a conflict, so of two calls at once the second sees what the first wrote and fails the
      // condition. A repository that is not in the workspace is never inserted.
      const claimed = await sql<
        Selectable<TrackerSyncStateTable>
      >`insert into tracker_sync_state (repository_id, workspace_id, project_id, "cursor", started_at, last_full_sync_at, updated_at)
        select r.id, r.workspace_id, (select p.id from projects p where p.repository_id = r.id), ${claim.cursor}::text, ${claim.startedAt}::text, null, ${at}::text
        from repositories r
        where r.id = ${repositoryId} and r.workspace_id = ${workspaceId}
        on conflict (repository_id) do update set
          project_id = coalesce(excluded.project_id, tracker_sync_state.project_id),
          "cursor" = excluded."cursor",
          started_at = excluded.started_at,
          updated_at = excluded.updated_at
        where tracker_sync_state.workspace_id = ${workspaceId}
          and (
            tracker_sync_state."cursor" is null
            or tracker_sync_state.started_at is null
            or tracker_sync_state.updated_at < ${claim.staleBefore}
            ${replacing}
          )
        returning *`.execute(db);
      const row = claimed.rows[0];
      if (row !== undefined)
        return { claimed: true, state: syncStateFrom(row) };
      return { claimed: false, state: await getSyncState(repositoryId) };
    },

    async saveSyncState(repositoryId, state) {
      const at = formatTimestamp(now());
      const columns = [
        sql`project_id = coalesce(excluded.project_id, tracker_sync_state.project_id)`,
        ...(state.cursor === undefined
          ? []
          : [sql`"cursor" = excluded."cursor"`]),
        ...(state.startedAt === undefined
          ? []
          : [sql`started_at = excluded.started_at`]),
        ...(state.lastFullSyncAt === undefined
          ? []
          : [sql`last_full_sync_at = excluded.last_full_sync_at`]),
        sql`updated_at = excluded.updated_at`,
      ];
      await sql`insert into tracker_sync_state (repository_id, workspace_id, project_id, "cursor", started_at, last_full_sync_at, updated_at)
        select r.id, r.workspace_id, (select p.id from projects p where p.repository_id = r.id), ${state.cursor ?? null}::text, ${state.startedAt ?? null}::text,
          ${state.lastFullSyncAt ?? null}::text, ${at}::text
        from repositories r
        where r.id = ${repositoryId} and r.workspace_id = ${workspaceId}
        on conflict (repository_id) do update set ${sql.join(columns)}
        where tracker_sync_state.workspace_id = ${workspaceId}`.execute(db);
    },
  };
}
