// SPDX-License-Identifier: LicenseRef-Proprietary

// The settled usage records of EVERY workspace, in one ordered feed, for the operator API (#278). Instance level on
// purpose (like integration-directory-repository.ts and runner-jobs-repository.ts): the operator serves many
// workspaces from one token and reads what they all consumed, so there is no single workspace to scope to, and
// every item names its own. It only reads, never a `reserved` or `void` record, and nothing it returns is written
// back. The reads of ONE workspace (its page, its summary) are those of the scoped usage-records-repository.ts.
import "server-only";
import type { ExpressionBuilder, Kysely } from "kysely";
import type { Database } from "../schema.ts";
import type { UsageKeyMode } from "../../usage/usage-records.ts";
import {
  afterUsageCursor,
  toUsageRecord,
  type UsageCursor,
  type UsageRecordsPage,
} from "./usage-records-repository.ts";

/** How many settled runs of a workspace on one key mode ended without a known cost (#385). Nothing else is in it. */
export type UnknownCostCount = {
  workspaceId: string;
  keyMode: UsageKeyMode;
  unknownCostCount: number;
};

export type UnknownCostCountsPage = {
  /** Ordered by workspace id, then key mode; a combination without an unknown cost is not listed. */
  counts: UnknownCostCount[];
  /** The last workspace of this page when there are more, else null. */
  nextAfter: string | null;
};

export type UsageFeedRepository = {
  /**
   * Settled records after the cursor, ordered by `(settledAt, id)`. `settledBefore` keeps back the records
   * settled at or after that time (the safety lag of the operator API). An empty page returns the cursor that
   * was passed.
   */
  pageSettled(options: {
    after?: UsageCursor | undefined;
    limit: number;
    settledBefore?: string | undefined;
  }): Promise<UsageRecordsPage>;

  /**
   * The settled runs without a known cost (#385) that started in `[from, to)`, per workspace and key mode: the rule
   * of the period of the summary and of the limits (`reserved_at`), so it agrees with both. A run that ended with
   * no result counts (its cost is unknown); a running or void record never does. The count is read from the records,
   * which the settlement writes in its own transaction, so it cannot drift from them. Pages hold whole workspaces
   * (`limit` of them), after the workspace id `after`.
   */
  unknownCostCounts(options: {
    from: string;
    to: string;
    after?: string | undefined;
    limit: number;
  }): Promise<UnknownCostCountsPage>;
};

export function createUsageFeedRepository(
  db: Kysely<Database>,
): UsageFeedRepository {
  return {
    async pageSettled({ after, limit, settledBefore }) {
      let query = db
        .selectFrom("usage_records")
        .selectAll()
        .where("state", "=", "settled");
      if (after !== undefined) query = query.where(afterUsageCursor(after));
      if (settledBefore !== undefined)
        query = query.where("settled_at", "<", settledBefore);
      const rows = await query
        .orderBy("settled_at")
        .orderBy("id")
        .limit(limit)
        .execute();
      const records = rows.map(toUsageRecord);
      const last = records.at(-1);
      return {
        records,
        next:
          last?.settledAt == null
            ? after
            : { settledAt: last.settledAt, id: last.id },
      };
    },

    async unknownCostCounts({ from, to, after, limit }) {
      const unknownCost = (eb: ExpressionBuilder<Database, "usage_records">) =>
        eb.and([
          eb("state", "=", "settled"),
          eb("cost_micro_usd", "is", null),
          // A turn on a subscription has no cost to know (#856).
          eb("cost_basis", "is", null),
          eb("reserved_at", ">=", from),
          eb("reserved_at", "<", to),
        ]);
      // One more workspace than the page holds tells whether there is another page.
      let workspaces = db
        .selectFrom("usage_records")
        .select("workspace_id")
        .distinct()
        .where(unknownCost);
      if (after !== undefined)
        workspaces = workspaces.where("workspace_id", ">", after);
      const rows = await db
        .selectFrom("usage_records")
        .select([
          "workspace_id",
          "key_mode",
          (eb) => eb.fn.countAll().as("unknown"),
        ])
        .where(unknownCost)
        .where(
          "workspace_id",
          "in",
          workspaces.orderBy("workspace_id").limit(limit + 1),
        )
        .groupBy(["workspace_id", "key_mode"])
        .orderBy("workspace_id")
        .orderBy("key_mode")
        .execute();
      // The rows come in the order of the database, so the extra workspace is told by position, never by comparing
      // ids here (the collation of the database and JavaScript's order need not agree).
      const ids = [...new Set(rows.map((row) => row.workspace_id))];
      const extra = ids[limit];
      return {
        counts: rows
          .filter((row) => row.workspace_id !== extra)
          .map((row) => ({
            workspaceId: row.workspace_id,
            keyMode: row.key_mode as UsageKeyMode,
            unknownCostCount: Number(row.unknown),
          })),
        nextAfter: extra === undefined ? null : (ids[limit - 1] ?? null),
      };
    },
  };
}
