// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the usage records of ONE workspace (the table `usage_records`; the factory takes the workspace id, see
// ../workspace-scope.ts): what each of its runs consumed (src/usage/README.md). The claim reserves a record, the
// completion of the job settles or voids it; a settled or void record never changes again. The reads are the
// only ones that exist: a count of runs by kind, the settled managed cost, and a page of settled records after a
// cursor. A record of another workspace is simply not there: a job of another workspace cannot be reserved or
// settled by id.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, UsageRecordsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import {
  jobKindOf,
  projectKindOf,
  type JobKind,
  type ProjectReviewKind,
} from "../../job-kind/job-kind.ts";
import type {
  SettledReason,
  UsageKeyMode,
  UsageSettlement,
  UsageState,
} from "../../usage/usage-records.ts";

/** A usage record as the rest of the app sees it. Timestamps are ISO 8601 text in UTC. */
export type UsageRecord = {
  id: string;
  workspaceId: string;
  jobId: string;
  /** The kind of the job the record is for; a turn of the Implementer has its own (#752). */
  reviewKind: JobKind;
  keyMode: UsageKeyMode;
  /** The managed model tier of a run from before the catalog (#280, #434); null for every newer run and for an own run. Read only: nothing writes it. The name, never the model. */
  modelTier: string | null;
  /** The catalog entry a managed run used (#432), and its name as it was at the claim; null for an own run and old rows. */
  catalogEntryId: string | null;
  catalogEntryName: string | null;
  /** The provider the run was sent to (#432). Operator data: never part of a view a member reads. */
  llmProvider: string | null;
  state: UsageState;
  /** Millionths of a US dollar; null when unknown. Only a settled record has one. */
  costMicroUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reservedAt: string;
  /** Null until the record is settled (a void record has none). */
  settledAt: string | null;
  /** Why it was settled without a report of its run (`no_result`); null when the run reported, and while not settled. */
  settledReason: SettledReason | null;
};

/** Where a reader stopped in the settled records: the next page starts after this `(settledAt, id)`. */
export type UsageCursor = { settledAt: string; id: string };

/** A page of settled records is read with these bounds (all optional). Times are ISO 8601 text in UTC. */
export type UsagePageOptions = {
  after?: UsageCursor | undefined;
  limit: number;
  /**
   * Only records settled strictly before this time. The operator API passes "now minus the safety lag", so that a
   * record that commits late is never behind a position a reader already holds (src/operator-api/README.md).
   */
  settledBefore?: string | undefined;
  /** Only records settled at or after this time. */
  from?: string | undefined;
  /** Only records settled before this time. */
  to?: string | undefined;
};

/** What one workspace ran in a period, for one kind of review and one key mode. */
export type UsageSummaryGroup = {
  reviewKind: JobKind;
  keyMode: UsageKeyMode;
  /** Runs that count (`reserved` and `settled`; never `void`, never a run that was superseded). */
  recordCount: number;
  settledCount: number;
  /** Runs a newer push replaced (#397): not counted above, but their cost and unknown costs are in the sums below. */
  supersededCount: number;
  /** Sum of the known cost of the settled runs, micro-USD. */
  knownCostMicroUsd: number;
  /** Settled runs whose cost is unknown. */
  unknownCostCount: number;
};

export type UsageRecordsPage = {
  records: UsageRecord[];
  /** The cursor to pass for the next page: the last record's, or the cursor that was passed when the page is empty. */
  next: UsageCursor | undefined;
};

export type UsageRecordsRepository = {
  /**
   * Inserts the `reserved` record of a job of this workspace, with the kind of the job. A job that has a
   * record already (claimed again after a lost lease) keeps it: nothing is inserted or changed, so the job
   * never counts twice. A job of another workspace, or none, gets no record.
   */
  reserve(jobId: string, keyMode: UsageKeyMode): Promise<void>;
  /**
   * Marks the record of a job that a claim with billing on handed out: its money is `open` (#605). A record that has a state
   * keeps it, so a job claimed again after a lost lease is not opened twice and a settled one is never reopened. Called by the
   * claim only while billing is on; with billing off nothing writes the column.
   */
  openBilling(jobId: string): Promise<void>;
  /**
   * Ends the billing of a job: `open` becomes `settled`. Returns whether this call did it, so of two settlements racing for one
   * job exactly one goes on to charge (the row lock of the update decides; the other finds it `settled`).
   */
  closeBilling(jobId: string): Promise<boolean>;
  /** Corrects the key mode of a record that is still `reserved`; any other record is left as it is. */
  setKeyMode(jobId: string, keyMode: UsageKeyMode): Promise<void>;
  /**
   * Notes the provider and, for a managed run, the catalog entry (id and name as they are now) a job was given (#432) on a
   * record that is still `reserved`; any other record is left as it is. Never the model.
   */
  setSelection(
    jobId: string,
    selection: {
      provider: string;
      catalogEntry: { id: string; name: string } | null;
    },
  ): Promise<void>;
  /**
   * Ends the record of a job: `settled` with the cost and tokens, or `void`. Only a `reserved` record
   * changes, so repeating it does nothing. A job without a record (it was claimed before records existed)
   * gets one in its final state, with key mode `own`. Returns whether this call changed or created the record
   * (false: it was final already, or the job is not this workspace's).
   */
  settle(jobId: string, settlement: UsageSettlement): Promise<boolean>;
  /**
   * Voids the `reserved` records of this workspace whose job has ended without reporting (cancelled, replaced,
   * or otherwise final), so a run that was dropped while it waited again no longer counts. Called in the
   * transaction of every transition that ends a waiting job.
   */
  voidEndedJobs(): Promise<void>;
  /**
   * `voidEndedJobs` that says whose record it voided (#498: the caller settles their holds in the same transaction).
   * The ids are those of this workspace's jobs only.
   */
  voidEndedJobsWithIds(): Promise<string[]>;
  /**
   * #397: marks the `reserved` records of these jobs of this workspace as superseded runs (reason `superseded`): the
   * run was replaced by a newer push and is draining. It stays `reserved` until its Worker reports or the drain ends,
   * but it no longer counts as a run of the quota, and `voidEndedJobs` leaves it alone.
   */
  markSuperseded(jobIds: readonly string[]): Promise<void>;
  get(jobId: string): Promise<UsageRecord | undefined>;
  /** Records that count (`reserved` and `settled`, never `void`) reserved at or after `since`, per review kind. */
  countByKind(since: string): Promise<Record<ProjectReviewKind, number>>;
  /**
   * How many reviews this workspace started after `since` (exclusive): every record reserved later, whatever became of it,
   * `void` and superseded ones included, because the claim that reserved it did start the review (#499, the hourly brake).
   * `exceptJobId` leaves out the record of the job that asks, so a job claimed again after a lost lease is not counted against
   * itself.
   */
  startedSince(
    since: string,
    options?: { exceptJobId?: string },
  ): Promise<number>;
  /**
   * The cost of the settled records of the runs on `keyMode` reserved at or after `since` (the period of the run,
   * as in `countByKind`); an unknown cost adds nothing. A record counts under the key mode it was settled with,
   * whatever the entitlements say now (#361).
   */
  sumSettledCostMicroUsd(since: string, keyMode: UsageKeyMode): Promise<number>;
  /** Settled records after the cursor, ordered by `(settledAt, id)`; never a `reserved` or `void` record. */
  pageSettled(options: UsagePageOptions): Promise<UsageRecordsPage>;
  /**
   * The runs that started in `[from, to)` (a run belongs to the period it started in, as for the limits), per
   * review kind and key mode, ordered by kind then key mode. A kind and key mode without runs is not listed.
   */
  summarize(period: { from: string; to: string }): Promise<UsageSummaryGroup[]>;
};

/** A row of the table as the rest of the app sees it (shared with the instance level feed). */
export function toUsageRecord(row: Selectable<UsageRecordsTable>): UsageRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    jobId: row.job_id,
    reviewKind: jobKindOf(row.review_kind),
    keyMode: row.key_mode as UsageKeyMode,
    modelTier: row.model_tier,
    catalogEntryId: row.catalog_entry_id,
    catalogEntryName: row.catalog_entry_name,
    llmProvider: row.llm_provider,
    state: row.state as UsageState,
    costMicroUsd: row.cost_micro_usd,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    reservedAt: row.reserved_at,
    settledAt: row.settled_at,
    settledReason: row.settled_reason as SettledReason | null,
  };
}

/** The rows after a cursor in `(settled_at, id)` order, as a condition on `usage_records`. */
export function afterUsageCursor(after: UsageCursor) {
  return sql<boolean>`(settled_at > ${after.settledAt} or (settled_at = ${after.settledAt} and id > ${after.id}))`;
}

/** The statuses a job never leaves (src/db/job-status.ts). */
const ENDED_JOB_STATUSES = ["succeeded", "failed", "cancelled", "superseded"];

export function createUsageRecordsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
): UsageRecordsRepository {
  /** The job of this workspace, or undefined. */
  function jobOf(jobId: string) {
    return db
      .selectFrom("jobs")
      .select(["id", "review_kind", "claimed_at"])
      .where("id", "=", jobId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
  }

  async function voidEnded(): Promise<string[]> {
    const voided = await db
      .updateTable("usage_records")
      .set({ state: "void" })
      .where("workspace_id", "=", workspaceId)
      // A run that was superseded while it ran keeps its record until it reports (#397).
      .where("settled_reason", "is", null)
      // A literal, not a bound value, so the planner can use the partial index of the reserved records.
      .where("state", "=", sql.lit("reserved"))
      // Driven by the few reserved records, each probing its job by primary key.
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("jobs")
            .select("jobs.id")
            .whereRef("jobs.id", "=", "usage_records.job_id")
            .where("jobs.workspace_id", "=", workspaceId)
            .where("jobs.status", "in", ENDED_JOB_STATUSES),
        ),
      )
      .returning("job_id")
      .execute();
    return voided.map((row) => row.job_id);
  }

  return {
    async reserve(jobId, keyMode) {
      const job = await jobOf(jobId);
      if (job === undefined) return;
      await db
        .insertInto("usage_records")
        .values({
          id: newId(),
          workspace_id: workspaceId,
          job_id: job.id,
          review_kind: job.review_kind,
          key_mode: keyMode,
          state: "reserved",
          reserved_at: formatTimestamp(now()),
        })
        .onConflict((conflict) => conflict.column("job_id").doNothing())
        .execute();
    },

    async openBilling(jobId) {
      await db
        .updateTable("usage_records")
        .set({ billing_state: "open" })
        .where("job_id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .where("billing_state", "is", null)
        .execute();
    },

    async closeBilling(jobId) {
      const closed = await db
        .updateTable("usage_records")
        .set({ billing_state: "settled" })
        .where("job_id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .where("billing_state", "=", "open")
        .returning("job_id")
        .executeTakeFirst();
      return closed !== undefined;
    },

    async setKeyMode(jobId, keyMode) {
      await db
        .updateTable("usage_records")
        .set({ key_mode: keyMode })
        .where("job_id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .where("state", "=", "reserved")
        .execute();
    },

    async setSelection(jobId, { provider, catalogEntry }) {
      await db
        .updateTable("usage_records")
        .set({
          llm_provider: provider,
          catalog_entry_id: catalogEntry?.id ?? null,
          catalog_entry_name: catalogEntry?.name ?? null,
        })
        .where("job_id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .where("state", "=", "reserved")
        .execute();
    },

    async settle(jobId, settlement) {
      const job = await jobOf(jobId);
      if (job === undefined) return false;
      const timestamp = formatTimestamp(now());
      const final =
        settlement.state === "settled"
          ? {
              state: "settled",
              cost_micro_usd: settlement.costMicroUsd,
              prompt_tokens: settlement.promptTokens,
              completion_tokens: settlement.completionTokens,
              settled_at: timestamp,
              settled_reason: settlement.reason ?? null,
            }
          : {
              state: "void",
              cost_micro_usd: null,
              prompt_tokens: null,
              completion_tokens: null,
              settled_at: null,
              settled_reason: null,
            };
      // One statement: a reserved record is ended, a final one is left alone, a missing one is created.
      const changed = await db
        .insertInto("usage_records")
        .values({
          id: newId(),
          workspace_id: workspaceId,
          job_id: job.id,
          review_kind: job.review_kind,
          key_mode: "own",
          // A job claimed before records existed: its claim is the best date of the run.
          reserved_at: job.claimed_at ?? timestamp,
          ...final,
        })
        .onConflict((conflict) =>
          conflict
            .column("job_id")
            .doUpdateSet(final)
            .where("usage_records.state", "=", "reserved")
            .where("usage_records.workspace_id", "=", workspaceId),
        )
        .returning("id")
        .executeTakeFirst();
      return changed !== undefined;
    },

    async markSuperseded(jobIds) {
      if (jobIds.length === 0) return;
      await db
        .updateTable("usage_records")
        .set({ settled_reason: "superseded" })
        .where("workspace_id", "=", workspaceId)
        .where("job_id", "in", [...jobIds])
        .where("state", "=", "reserved")
        .execute();
    },

    voidEndedJobs: async () => {
      await voidEnded();
    },

    voidEndedJobsWithIds: voidEnded,

    async get(jobId) {
      const row = await db
        .selectFrom("usage_records")
        .selectAll()
        .where("job_id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      return row === undefined ? undefined : toUsageRecord(row);
    },

    async countByKind(since) {
      const rows = await db
        .selectFrom("usage_records")
        .select(["review_kind", (eb) => eb.fn.countAll().as("runs")])
        .where("workspace_id", "=", workspaceId)
        .where("state", "in", ["reserved", "settled"])
        // A run that a newer push replaced is not a run of the quota (#397); its cost still counts as usage.
        .where((eb) =>
          eb.or([
            eb("settled_reason", "is", null),
            eb("settled_reason", "<>", "superseded"),
          ]),
        )
        .where("reserved_at", ">=", since)
        .groupBy("review_kind")
        .execute();
      const counts: Record<ProjectReviewKind, number> = { diff: 0, dynamic: 0 };
      // #752: the runs of a turn of the Implementer count with the Dynamic runs of the plan (`projectKindOf`).
      for (const row of rows)
        counts[projectKindOf(jobKindOf(row.review_kind))] += Number(row.runs);
      return counts;
    },

    async startedSince(since, options = {}) {
      let query = db
        .selectFrom("usage_records")
        .select((eb) => eb.fn.countAll().as("started"))
        .where("workspace_id", "=", workspaceId)
        .where("reserved_at", ">", since);
      if (options.exceptJobId !== undefined)
        query = query.where("job_id", "<>", options.exceptJobId);
      return Number((await query.executeTakeFirstOrThrow()).started);
    },

    async sumSettledCostMicroUsd(since, keyMode) {
      const row = await db
        .selectFrom("usage_records")
        .select((eb) => eb.fn.sum("cost_micro_usd").as("total"))
        .where("workspace_id", "=", workspaceId)
        .where("state", "=", "settled")
        .where("key_mode", "=", keyMode)
        .where("reserved_at", ">=", since)
        .executeTakeFirst();
      return Number(row?.total ?? 0);
    },

    async pageSettled({ after, limit, settledBefore, from, to }) {
      let query = db
        .selectFrom("usage_records")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("state", "=", "settled");
      if (after !== undefined) query = query.where(afterUsageCursor(after));
      if (settledBefore !== undefined)
        query = query.where("settled_at", "<", settledBefore);
      if (from !== undefined) query = query.where("settled_at", ">=", from);
      if (to !== undefined) query = query.where("settled_at", "<", to);
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

    async summarize({ from, to }) {
      const rows = await db
        .selectFrom("usage_records")
        .select([
          "review_kind",
          "key_mode",
          sql`sum(case when settled_reason is null or settled_reason <> 'superseded' then 1 else 0 end)`.as(
            "records",
          ),
          sql`sum(case when state = 'settled' and (settled_reason is null or settled_reason <> 'superseded') then 1 else 0 end)`.as(
            "settled",
          ),
          sql`sum(case when settled_reason = 'superseded' then 1 else 0 end)`.as(
            "superseded",
          ),
          (eb) => eb.fn.sum("cost_micro_usd").as("cost"),
          sql`sum(case when state = 'settled' and cost_micro_usd is null then 1 else 0 end)`.as(
            "unknown",
          ),
        ])
        .where("workspace_id", "=", workspaceId)
        .where("state", "in", ["reserved", "settled"])
        .where("reserved_at", ">=", from)
        .where("reserved_at", "<", to)
        .groupBy(["review_kind", "key_mode"])
        .orderBy("review_kind")
        .orderBy("key_mode")
        .execute();
      return rows.map((row) => ({
        reviewKind: jobKindOf(row.review_kind),
        keyMode: row.key_mode as UsageKeyMode,
        recordCount: Number(row.records),
        settledCount: Number(row.settled),
        supersededCount: Number(row.superseded),
        knownCostMicroUsd: Number(row.cost ?? 0),
        unknownCostCount: Number(row.unknown),
      }));
    },
  };
}
