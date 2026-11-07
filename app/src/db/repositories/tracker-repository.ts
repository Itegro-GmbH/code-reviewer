// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the ticket mirror of ONE workspace (#923; the factory takes the workspace id, see ../workspace-scope.ts): `tracker_items`, the
// read cache of the issues and pull requests of a repository, and `tracker_sync_state`, where a full sync stands. The only code that
// reads or writes them. The cache is rebuilt from the provider at any time and is never the source of truth (`src/tracker/README.md`):
// nothing here decides what a value means, the values are stored as the provider delivers them.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import { decodeJson, encodeJson, formatTimestamp } from "../codecs.ts";
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

export type TrackerRepository = {
  /** Writes the item: inserts it, or replaces what the provider says of it. Board status, pull requests and checks stay as they are. */
  upsertItem(repositoryId: string, item: TrackerItemWrite): Promise<void>;
  getItem(
    repositoryId: string,
    number: number,
  ): Promise<TrackerItem | undefined>;
  /** The items of the repository, the newest change first. */
  listItems(
    repositoryId: string,
    filter: TrackerItemFilter,
  ): Promise<TrackerItem[]>;
  /** Removes the item; answers whether there was one. */
  deleteItem(repositoryId: string, number: number): Promise<boolean>;
  /** Sets the board status of the item the board names by its node id (any repository of the workspace); answers how many rows changed. */
  setBoardStatusByNode(nodeId: string, status: string | null): Promise<number>;
  /** Sets the parent of an issue; answers whether the issue is cached. */
  setParent(
    repositoryId: string,
    number: number,
    parent: number | null,
  ): Promise<boolean>;
  setChecksState(
    repositoryId: string,
    number: number,
    state: string | null,
  ): Promise<boolean>;
  /**
   * Computes `pullRequests` again for these issues (all issues of the repository when none are named) from the `closes` of the cached
   * pull requests: an issue lists the pull requests that close it.
   */
  linkPullRequests(
    repositoryId: string,
    issueNumbers?: readonly number[],
  ): Promise<void>;
  /** Forgets the board statuses (a full sync of the board starts from nothing). */
  clearBoardStatuses(repositoryId: string): Promise<void>;
  /** Forgets the checks of every pull request (a full sync of them starts from nothing). */
  clearChecksStates(repositoryId: string): Promise<void>;
  /** Removes the items not written since `before`; answers how many. */
  removeNotWrittenSince(repositoryId: string, before: string): Promise<number>;
  getSyncState(repositoryId: string): Promise<TrackerSyncState | undefined>;
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
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
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

  return {
    async upsertItem(repositoryId, item) {
      const at = formatTimestamp(now());
      const values = {
        workspace_id: workspaceId,
        repository_id: repositoryId,
        provider: item.provider,
        repo: item.repo,
        number: item.number,
        node_id: item.nodeId,
        kind: item.kind,
        state: item.state,
        state_reason: item.stateReason,
        type: item.type,
        title: item.title,
        body_excerpt: item.bodyExcerpt,
        labels: encodeJson(item.labels),
        assignees: encodeJson(item.assignees),
        closes: encodeJson(item.closes),
        updated_at: item.updatedAt,
        synced_at: at,
      };
      const parent =
        item.parentNumber === undefined
          ? {}
          : { parent_number: item.parentNumber };
      await db
        .insertInto("tracker_items")
        .values({
          ...values,
          // What other deliveries fill in: empty for a ticket seen for the first time, and kept when it is written again.
          project_id: null,
          board_status: null,
          parent_number: item.parentNumber ?? null,
          pull_requests: "[]",
          checks_state: null,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["repository_id", "number"])
            .doUpdateSet({
              ...values,
              ...parent,
            })
            // The row of another workspace is never touched, even if a repository id were reused.
            .where("tracker_items.workspace_id", "=", workspaceId),
        )
        .execute();
    },

    async getItem(repositoryId, number) {
      const row = await db
        .selectFrom("tracker_items")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("number", "=", number)
        .executeTakeFirst();
      return row === undefined ? undefined : itemFrom(row);
    },

    async listItems(repositoryId, filter) {
      let query = db
        .selectFrom("tracker_items")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId);
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

    async deleteItem(repositoryId, number) {
      const result = await db
        .deleteFrom("tracker_items")
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("number", "=", number)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },

    async setBoardStatusByNode(nodeId, status) {
      const result = await db
        .updateTable("tracker_items")
        .set({ board_status: status, synced_at: formatTimestamp(now()) })
        .where("workspace_id", "=", workspaceId)
        .where("node_id", "=", nodeId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async setParent(repositoryId, number, parent) {
      const result = await own(repositoryId, number)
        .set({ parent_number: parent, synced_at: formatTimestamp(now()) })
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async setChecksState(repositoryId, number, state) {
      const result = await own(repositoryId, number)
        .set({ checks_state: state, synced_at: formatTimestamp(now()) })
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async linkPullRequests(repositoryId, issueNumbers) {
      if (issueNumbers?.length === 0) return;
      const only =
        issueNumbers === undefined
          ? sql``
          : sql`and i.number in (${sql.join(issueNumbers.map((number) => sql.lit(number)))})`;
      await sql`update tracker_items i
        set pull_requests = coalesce((
          select jsonb_agg(p.number order by p.number)::text
          from tracker_items p
          where p.workspace_id = i.workspace_id
            and p.repository_id = i.repository_id
            and p.kind = 'pull_request'
            and p.closes::jsonb @> jsonb_build_array(i.number)
        ), '[]')
        where i.workspace_id = ${workspaceId}
          and i.repository_id = ${repositoryId}
          and i.kind = 'issue'
          ${only}`.execute(db);
    },

    async clearBoardStatuses(repositoryId) {
      await db
        .updateTable("tracker_items")
        .set({ board_status: null })
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("board_status", "is not", null)
        .execute();
    },

    async clearChecksStates(repositoryId) {
      await db
        .updateTable("tracker_items")
        .set({ checks_state: null })
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("checks_state", "is not", null)
        .execute();
    },

    async removeNotWrittenSince(repositoryId, before) {
      const result = await db
        .deleteFrom("tracker_items")
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .where("synced_at", "<", before)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },

    async getSyncState(repositoryId) {
      const row = await db
        .selectFrom("tracker_sync_state")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .executeTakeFirst();
      return row === undefined ? undefined : syncStateFrom(row);
    },

    async saveSyncState(repositoryId, state) {
      const at = formatTimestamp(now());
      const given = {
        ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
        ...(state.startedAt === undefined
          ? {}
          : { started_at: state.startedAt }),
        ...(state.lastFullSyncAt === undefined
          ? {}
          : { last_full_sync_at: state.lastFullSyncAt }),
      };
      await db
        .insertInto("tracker_sync_state")
        .values({
          repository_id: repositoryId,
          workspace_id: workspaceId,
          cursor: null,
          started_at: null,
          last_full_sync_at: null,
          ...given,
          updated_at: at,
        })
        .onConflict((conflict) =>
          conflict
            .column("repository_id")
            .doUpdateSet({ ...given, updated_at: at })
            .where("tracker_sync_state.workspace_id", "=", workspaceId),
        )
        .execute();
    },
  };
}
