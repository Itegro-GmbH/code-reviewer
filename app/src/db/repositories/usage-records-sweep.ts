// SPDX-License-Identifier: LicenseRef-Proprietary

// The sweep of usage records (src/usage/README.md), and of the sessions of the Implementer whose turn ended, for the instance level code that ends jobs: the lease side of
// the queue (runner-jobs-repository.ts) and the switch-off of Dynamic Review (instance-settings-repository.ts).
// Instance level on purpose, like they are: it looks at the records of every workspace. The scoped twin for the
// jobs of one workspace is `voidEndedJobs()` of usage-records-repository.ts.
import "server-only";
import { sql, type Kysely } from "kysely";
import { SUPERSEDED_REPORT_GRACE_MS } from "../supersede-timing.ts";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import { settleEndedJobs } from "../../billing/settle-jobs.ts";
import { idleSessionsOfEndedTurns } from "./implementer-sessions-sweep.ts";
import {
  NO_RESULT_JOB_ERROR_CODES,
  type UnknownCostSettlement,
} from "../../usage/usage-records.ts";

/** The statuses a job never leaves (src/db/job-status.ts). */
const ENDED_JOB_STATUSES = ["succeeded", "failed", "cancelled", "superseded"];

/**
 * Closes the `reserved` records of jobs that ended without a report of their run, in the transaction of the
 * transition that ended them (src/usage/README.md). A job that was completed already has a settled or void record,
 * which this leaves alone.
 *
 * - A job a runner held that then ended with no result (its lease ran out on the last attempt, it ran past the hard
 *   limit, its runner was shut down on the last attempt) may have used the model: its record is `settled` with an
 *   unknown cost and unknown tokens, and the reason `no_result`. Counting it is the conservative reading (#273).
 * - A run that was superseded while it ran (#397) has its record marked `superseded` and keeps it reserved while its
 *   Worker drains. When the claim ran out, and the grace for a late report after it, without a report, the record is `settled` with an
 *   unknown cost and unknown tokens: the model may have been in use for the request in flight, and nothing is
 *   guessed. It does not count as a run of the quota (the reason), and an unknown cost is never billed.
 * - Any other ended job (cancelled, replaced while it waited, refused at claim, given back before the runner began,
 *   never dispatched) made no model call anybody knows of: its record is void and does not count.
 *
 * Two statements over the reserved records only (a partial index), each driven by those few records and probing
 * their job by primary key, so the work does not grow with the history of ended jobs.
 *
 * Returns the records it settled without a cost (the first statement), so the caller can raise the alert for
 * unknown costs once its transaction committed (#361).
 *
 * #498: the hold of every job whose record this ended is settled in the same transaction (`settleEndedJobs`: a release and,
 * unless the run is free, a usage entry), after the three statements; with billing off that reads the switch and nothing else.
 */
export async function closeRecordsOfEndedJobs(
  executor: Kysely<Database>,
  settledAt: string,
): Promise<UnknownCostSettlement[]> {
  // #752: every place that ends a job without a report of its run calls this, so it is also where the session of a turn that
  // ended that way gets idle again (it would stay `running` for good otherwise).
  await idleSessionsOfEndedTurns(executor, settledAt);
  const settled = await executor
    .updateTable("usage_records")
    .set({
      state: "settled",
      settled_at: settledAt,
      settled_reason: "no_result",
    })
    // A literal, not a bound value, so the planner can use the partial index of the reserved records.
    .where("state", "=", sql.lit("reserved"))
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("jobs")
          .select("jobs.id")
          .whereRef("jobs.id", "=", "usage_records.job_id")
          .where("jobs.status", "=", "failed")
          .where("jobs.error_code", "in", [...NO_RESULT_JOB_ERROR_CODES]),
      ),
    )
    .returning(["workspace_id", "job_id"])
    .execute();
  const reportsClosedBefore = formatTimestamp(
    new Date(Date.parse(settledAt) - SUPERSEDED_REPORT_GRACE_MS),
  );
  const drained = await executor
    .updateTable("usage_records")
    .set({ state: "settled", settled_at: settledAt })
    .where("state", "=", sql.lit("reserved"))
    .where("settled_reason", "=", "superseded")
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("jobs")
          .select("jobs.id")
          .whereRef("jobs.id", "=", "usage_records.job_id")
          .where("jobs.status", "=", "superseded")
          .where("jobs.claimed_at", "is not", null)
          // The claim ran out and the grace for a late report too (`SUPERSEDED_REPORT_GRACE_MS`).
          .where("jobs.lease_expires_at", "<=", reportsClosedBefore),
      ),
    )
    .returning(["workspace_id", "job_id"])
    .execute();
  const voided = await executor
    .updateTable("usage_records")
    .set({ state: "void" })
    .where("state", "=", sql.lit("reserved"))
    // A superseded run that is still draining keeps its record (#397).
    .where("settled_reason", "is", null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("jobs")
          .select("jobs.id")
          .whereRef("jobs.id", "=", "usage_records.job_id")
          .where("jobs.status", "in", ENDED_JOB_STATUSES),
      ),
    )
    .returning("job_id")
    .execute();
  await settleEndedJobs(
    executor,
    [...settled, ...drained, ...voided].map((row) => row.job_id),
    () => new Date(settledAt),
  );
  return [...settled, ...drained].map((row) => ({
    workspaceId: row.workspace_id,
    jobId: row.job_id,
  }));
}
