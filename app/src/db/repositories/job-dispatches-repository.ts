// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to `job_dispatches` (#326): where the signed wake-up call of each job stands. Instance level, like
// the lease side of the queue: the sender and the sweep serve the whole instance and work from a job id they
// already hold. The table holds a job id and counters, no repository data. The rules (when to send, what an
// answer means) are in src/dispatch/; this module only moves rows.
import "server-only";
import { sql, type Kysely } from "kysely";
import {
  DISPATCH_RESULT_CODES,
  DISPATCH_STATES,
  type DispatchResultCode,
  type DispatchState,
  type DispatchUpdate,
} from "../../dispatch/outcome.ts";
import { jobKindOf, type JobKind } from "../../job-kind/job-kind.ts";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type DispatchRow = {
  jobId: string;
  state: DispatchState;
  attempts: number;
  consecutiveFailures: number;
  /** ISO 8601 text, exactly as stored (the claim of a send compares it). */
  nextDispatchAt: string;
  ackedAt: string | null;
  lastAttemptAt: string | null;
  lastStatus: number | null;
  lastCode: DispatchResultCode | null;
};

/**
 * The answers that mean "not now, ask again when something frees up" (#395, #479): the Dispatcher said
 * `not_claimable` (the pool cap, or the running job of the same pull request), `429` (busy: it is at its own cap) or
 * `503` (not ready: it is starting, launching or its platform failed). A row with one of these codes is sent again when a
 * job ends, whatever time it says: a `Retry-After` longer than a request can wait for (`INLINE_RETRY_MAX_WAIT_MS`)
 * used to leave the job to the repair work or the 2 hour sweep, which in a quiet system is the next event or two
 * hours. The row's own time still holds for every other sender (`listDue`, the sweep). The last call must be at
 * least `WAITING_MIN_GAP_MS` old, so a send in flight is never taken over, and no timer or poll is added: this runs
 * only in the request that ends a job.
 */
export const WAITING_DISPATCH_CODES = [
  "ignored_not_claimable",
  "rate_limited",
  "unavailable",
] as const;

/**
 * A waiting row is sent again only when its last call is at least this old. A call in flight holds the row (its
 * lease is the row's time) and `claimSend` compares that time only, so without this a second event that read the row
 * after the first claim would take the lease over and send the job twice. A call times out after 8 seconds.
 */
export const WAITING_MIN_GAP_MS = 9_000;

/** The pull request whose waiting job goes first when a slot frees (the one whose job just ended). */
export type PullRequestRef = { repositoryId: string; prNumber: number };

/** A queued job that is due and whose dispatch is missing or due: the work of one sweep. */
export type DueDispatchJob = {
  jobId: string;
  reviewKind: JobKind;
  /** The job's lost attempts so far; the call carries the number of the attempt it is on (this plus one). */
  jobAttempts: number;
};

export type JobDispatchesRepository = {
  get(jobId: string): Promise<DispatchRow | undefined>;
  /** #493: the workspace of a job, for the instance level code that goes on to a scoped repository; undefined if none. */
  workspaceOf(jobId: string): Promise<string | undefined>;
  /** Makes the row for a job, unless there is one. Returns whether this call made it. */
  create(jobId: string, nextDispatchAt: Date): Promise<boolean>;
  /**
   * Takes the right to send, for everyone else, and counts the attempt: moves `next_dispatch_at` from the
   * value the caller read to `leaseUntil`, only if it still is that value and the row is not stopped. At
   * most one of several callers (the request that queued the job, the sweep, another instance) gets
   * `true`. If the sender dies, the lease runs out and the job is due again. `attempts` is therefore 0
   * exactly while the job was never claimed for a send.
   */
  claimSend(
    jobId: string,
    expectedNextDispatchAt: string,
    leaseUntil: Date,
  ): Promise<boolean>;
  /** Stores what the send came to, and when the job is to be looked at next. */
  record(jobId: string, update: DispatchUpdate, at: Date): Promise<void>;
  /**
   * The queued jobs that are due now and have no dispatch row, or whose row is due and not stopped. The
   * sweep (#328) sends these (`DispatchService.sendDue`). Oldest first. With `minAgeMs` (#395) a job that changed less
   * than that long ago is left out: the hook of the request that queued it is still sending it.
   */
  listDue(
    now: Date,
    limit: number,
    minAgeMs?: number,
  ): Promise<DueDispatchJob[]>;
  /**
   * #395: the queued, due jobs whose last call was answered "not now" (`WAITING_DISPATCH_CODES`) at least
   * `WAITING_MIN_GAP_MS` ago, whatever time their row says: a slot freed, so they are asked again. A job whose own
   * pull request still has a running job is left out: it would be refused again and take the place of a job that
   * waits for the pool cap only. The job of `first` (the pull request whose job just ended) comes first, then the
   * oldest. Never a `stopped` row.
   */
  listWaiting(
    now: Date,
    limit: number,
    first?: PullRequestRef,
  ): Promise<DueDispatchJob[]>;
  /** #395: the job as a dispatch sees it, or undefined unless it is `queued` and due at `now`. */
  dueJob(jobId: string, now: Date): Promise<DueDispatchJob | undefined>;
  /**
   * #395: makes the dispatch of a queued job due at `at` again with the failures reset (the job was given back after a
   * launch that failed: its earlier call is spent). Creates the row if there is none. Returns when the job may be
   * claimed (its `run_after`), or undefined when the job is not queued.
   */
  resetForResend(jobId: string, at: Date): Promise<Date | undefined>;
  /**
   * #328: makes the `stopped` rows of jobs that are still queued and were stopped at or before `stoppedBefore`
   * pending again, due at `at`, with the failure count reset. A Dispatcher that could not run a review kind
   * may have been updated since; the sweep asks again at a slow pace. Returns how many rows.
   */
  reviveStopped(stoppedBefore: Date, at: Date): Promise<number>;
  /**
   * #328: removes the rows of jobs that finished at or before `cutoff` (nothing reads them any more). The
   * rows of a job that is queued or running are never removed. Returns how many.
   */
  deleteFinishedBefore(cutoff: Date): Promise<number>;
};

function isState(value: string): value is DispatchState {
  return (DISPATCH_STATES as readonly string[]).includes(value);
}

function isCode(value: string): value is DispatchResultCode {
  return (DISPATCH_RESULT_CODES as readonly string[]).includes(value);
}

export function createJobDispatchesRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): JobDispatchesRepository {
  return {
    async workspaceOf(jobId) {
      const row = await db
        .selectFrom("jobs")
        .select("workspace_id")
        .where("id", "=", jobId)
        .executeTakeFirst();
      return row?.workspace_id;
    },

    async get(jobId) {
      const row = await db
        .selectFrom("job_dispatches")
        .selectAll()
        .where("job_id", "=", jobId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      if (!isState(row.state))
        throw new Error(`Stored dispatch state ${row.state} is not known.`);
      return {
        jobId: row.job_id,
        state: row.state,
        attempts: row.attempts,
        consecutiveFailures: row.consecutive_failures,
        nextDispatchAt: row.next_dispatch_at,
        ackedAt: row.acked_at,
        lastAttemptAt: row.last_attempt_at,
        lastStatus: row.last_status,
        // A code a later release added reads as unknown rather than failing the reader.
        lastCode:
          row.last_code !== null && isCode(row.last_code)
            ? row.last_code
            : null,
      };
    },

    async create(jobId, nextDispatchAt) {
      const timestamp = formatTimestamp(now());
      const result = await db
        .insertInto("job_dispatches")
        .values({
          job_id: jobId,
          state: "pending",
          attempts: 0,
          consecutive_failures: 0,
          next_dispatch_at: formatTimestamp(nextDispatchAt),
          acked_at: null,
          last_attempt_at: null,
          last_status: null,
          last_code: null,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .onConflict((conflict) => conflict.column("job_id").doNothing())
        .executeTakeFirst();
      return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
    },

    async claimSend(jobId, expectedNextDispatchAt, leaseUntil) {
      const result = await db
        .updateTable("job_dispatches")
        .set({
          attempts: sql<number>`attempts + 1`,
          next_dispatch_at: formatTimestamp(leaseUntil),
          last_attempt_at: formatTimestamp(now()),
          updated_at: formatTimestamp(now()),
        })
        .where("job_id", "=", jobId)
        .where("next_dispatch_at", "=", expectedNextDispatchAt)
        .where("state", "<>", "stopped")
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async record(jobId, update, at) {
      await db
        .updateTable("job_dispatches")
        .set({
          state: update.state,
          consecutive_failures: update.consecutiveFailures,
          next_dispatch_at: formatTimestamp(update.nextDispatchAt),
          ...(update.acknowledged ? { acked_at: formatTimestamp(at) } : {}),
          last_status: update.lastStatus,
          last_code: update.lastCode,
          updated_at: formatTimestamp(now()),
        })
        .where("job_id", "=", jobId)
        .execute();
    },

    async reviveStopped(stoppedBefore, at) {
      const timestamp = formatTimestamp(at);
      const result = await db
        .updateTable("job_dispatches")
        .set({
          state: "pending",
          consecutive_failures: 0,
          next_dispatch_at: timestamp,
          updated_at: timestamp,
        })
        .where("state", "=", "stopped")
        .where("updated_at", "<=", formatTimestamp(stoppedBefore))
        .where("job_id", "in", (eb) =>
          eb
            .selectFrom("jobs")
            .select("jobs.id")
            .where("jobs.status", "=", "queued"),
        )
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async deleteFinishedBefore(cutoff) {
      const result = await db
        .deleteFrom("job_dispatches")
        .where("job_id", "in", (eb) =>
          eb
            .selectFrom("jobs")
            .select("jobs.id")
            .where("jobs.finished_at", "<=", formatTimestamp(cutoff)),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },

    async listWaiting(at, limit, first) {
      const timestamp = formatTimestamp(at);
      let query = db
        .selectFrom("jobs")
        .innerJoin("job_dispatches", "job_dispatches.job_id", "jobs.id")
        .select([
          "jobs.id as job_id",
          "jobs.review_kind as review_kind",
          "jobs.attempts as job_attempts",
        ])
        .where("jobs.status", "=", "queued")
        .where("jobs.run_after", "<=", timestamp)
        .where("job_dispatches.state", "=", "pending")
        .where("job_dispatches.attempts", ">", 0)
        .where("job_dispatches.last_code", "in", [...WAITING_DISPATCH_CODES])
        .where(
          "job_dispatches.last_attempt_at",
          "<=",
          formatTimestamp(new Date(at.getTime() - WAITING_MIN_GAP_MS)),
        )
        // Not blocked by its own pull request: one job runs per pull request, and a refusal for that reason says
        // nothing about a free slot.
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("jobs as busy")
                .select("busy.id")
                .where("busy.status", "=", "running")
                .whereRef("busy.repository_id", "=", "jobs.repository_id")
                .whereRef("busy.pr_number", "=", "jobs.pr_number"),
            ),
          ),
        );
      if (first !== undefined)
        query = query.orderBy(
          sql`case when jobs.repository_id = ${first.repositoryId} and jobs.pr_number = ${first.prNumber} then 0 else 1 end`,
        );
      const rows = await query
        .orderBy("jobs.run_after")
        .orderBy("jobs.id")
        .limit(limit)
        .execute();
      return rows.map(toDueJob);
    },

    async dueJob(jobId, at) {
      const row = await db
        .selectFrom("jobs")
        .select([
          "jobs.id as job_id",
          "jobs.review_kind as review_kind",
          "jobs.attempts as job_attempts",
        ])
        .where("jobs.id", "=", jobId)
        .where("jobs.status", "=", "queued")
        .where("jobs.run_after", "<=", formatTimestamp(at))
        .executeTakeFirst();
      return row === undefined ? undefined : toDueJob(row);
    },

    async resetForResend(jobId, at) {
      const queued = await db
        .selectFrom("jobs")
        .select("jobs.run_after")
        .where("jobs.id", "=", jobId)
        .where("jobs.status", "=", "queued")
        .executeTakeFirst();
      if (queued === undefined) return undefined;
      const timestamp = formatTimestamp(at);
      const stamped = formatTimestamp(now());
      await db
        .insertInto("job_dispatches")
        .values({
          job_id: jobId,
          state: "pending",
          attempts: 0,
          consecutive_failures: 0,
          next_dispatch_at: timestamp,
          acked_at: null,
          last_attempt_at: null,
          last_status: null,
          last_code: null,
          created_at: stamped,
          updated_at: stamped,
        })
        .onConflict((conflict) =>
          conflict.column("job_id").doUpdateSet({
            state: "pending",
            consecutive_failures: 0,
            next_dispatch_at: timestamp,
            updated_at: stamped,
          }),
        )
        .execute();
      return new Date(queued.run_after);
    },

    async listDue(at, limit, minAgeMs = 0) {
      const timestamp = formatTimestamp(at);
      const rows = await db
        .selectFrom("jobs")
        .leftJoin("job_dispatches", "job_dispatches.job_id", "jobs.id")
        .select([
          "jobs.id as job_id",
          "jobs.review_kind as review_kind",
          "jobs.attempts as job_attempts",
        ])
        .where("jobs.status", "=", "queued")
        .where("jobs.run_after", "<=", timestamp)
        .where(
          "jobs.updated_at",
          "<=",
          formatTimestamp(new Date(at.getTime() - minAgeMs)),
        )
        .where((eb) =>
          eb.or([
            eb("job_dispatches.job_id", "is", null),
            eb.and([
              eb("job_dispatches.state", "<>", "stopped"),
              eb("job_dispatches.next_dispatch_at", "<=", timestamp),
            ]),
          ]),
        )
        .orderBy("jobs.run_after")
        .orderBy("jobs.id")
        .limit(limit)
        .execute();
      return rows.map(toDueJob);
    },
  };
}

function toDueJob(row: {
  job_id: string;
  review_kind: string;
  job_attempts: number;
}): DueDispatchJob {
  return {
    jobId: row.job_id,
    // A kind this version does not know fails loudly: the old reading turned everything but Dynamic into Diff (#752).
    reviewKind: jobKindOf(row.review_kind),
    jobAttempts: row.job_attempts,
  };
}
