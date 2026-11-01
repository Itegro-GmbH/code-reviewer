// SPDX-License-Identifier: LicenseRef-Proprietary

// The lease side of the job queue: handing jobs to runners, keeping their leases alive, finishing
// and giving them back, and expiring what ran out. INSTANCE LEVEL, on purpose: runners serve the whole
// instance with one shared token, so a claim hands out the oldest due job of ANY workspace. Every
// statement that changes a claimed job is keyed on the job id and the lease token of the claim (the
// token is the fence), and what comes back is a `Job` with its `workspaceId`, so everything the caller
// does next goes through repositories created for that workspace. Creating, dropping and reading jobs
// is scoped and lives in jobs-repository.ts.
//
// Every public operation that reads before it writes runs in one transaction. Transactions on this
// database take the write lock up front (`begin immediate`, see `dialect.ts`), so the check "is there
// a job already?" and the update that follows it cannot be separated by another writer.
import "server-only";
import {
  lockDynamicReviewGate,
  lockJobRowsInOrder,
} from "../dynamic-review-lock.ts";
import { createInstanceSettingsRepository } from "./instance-settings-repository.ts";
import { isDeepStrictEqual } from "node:util";
import type { ExpressionBuilder, Kysely } from "kysely";
import {
  DEFAULT_JOB_QUEUE_LIMITS,
  IMPLEMENTER_MAX_ATTEMPTS,
  type JobQueueLimits,
} from "../job-limits.ts";
import {
  DEFAULT_ENGINES,
  reviewKindsForEngines,
  type RunnerEngine,
} from "../../jobs/runner-capabilities.ts";
import type { JobStatus } from "../job-status.ts";
import { jobKindOf } from "../../job-kind/job-kind.ts";
import {
  newLeaseToken,
  newWorkerCredential,
  workerLeaseToken,
} from "../../jobs/worker-credential.ts";
import type {
  CancelClaimedResult,
  ClaimResult,
  CompleteResult,
  CountFetchResult,
  HeartbeatResult,
  Job,
  JobErrorCode,
  JobOutcome,
  ReleaseOptions,
  ReleaseResult,
} from "../../jobs/job-types.ts";
import { encodeJson, formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import { SUPERSEDED_REPORT_GRACE_MS } from "../supersede-timing.ts";
import { isJobIndependentRefusal } from "../../usage/enforce-entitlements.ts";
import { admitClaimedJob, type ClaimRefusal } from "./claim-admission.ts";
import {
  RATES_INCOMPLETE_REFUSAL,
  admitAtClaim,
  noteRefusalForBalance,
  readClaimBilling,
  type AdmitOutcome,
  type ClaimBilling,
} from "../../billing/claim-billing.ts";
import {
  CLAIM_CAPS_RETRY_MS,
  checkClaimCaps,
  type CapOutcome,
} from "../../billing/claim-caps.ts";
import { headNoticeKey } from "../refusal-notice-key.ts";
import { claimOldestDueJob } from "./jobs-claim.ts";
import { toJob } from "./jobs-repository.ts";
import { createUsageRecordsRepository } from "./usage-records-repository.ts";
import { turnResultOf } from "../implementer-turn-result.ts";
import { createImplementerRepository } from "./implementer-repository.ts";
import { idleSessionsOfEndedTurns } from "./implementer-sessions-sweep.ts";
import { closeRecordsOfEndedJobs } from "./usage-records-sweep.ts";
import {
  ensureStartCreditWhileOn,
  logStartCreditGranted,
} from "../../billing/start-credit.ts";
import { settleEndedJobs } from "../../billing/settle-jobs.ts";
import {
  settlementOfOutcome,
  settlementOfSupersededOutcome,
  type UnknownCostSettlement,
} from "../../usage/usage-records.ts";

/**
 * Gives the session of a turn what its report says (#754) and sets it idle: the pushed head, the summary and the saved agent
 * session of the implementer block of `result`; a result without a block records nothing but the end. The caller is the
 * transaction that ends the job.
 */
async function recordTurnOfJob(
  trx: Kysely<Database>,
  job: { id: string; workspace_id: string },
  result: unknown,
  now: () => Date,
): Promise<void> {
  const sessions = createImplementerRepository(trx, job.workspace_id, now);
  const turn = await sessions.getTurnByJob(job.id);
  if (turn !== undefined)
    await sessions.recordTurnResult(turn.session.id, turnResultOf(result));
}

/** What `expireStaleJobs` did. */
export type ExpiryReport = {
  /** Running jobs whose lease ran out and that were put back in the queue. */
  requeued: number;
  /** Expired running leases that ended the job (last attempt, or Dynamic with its gate off). */
  leaseExpired: number;
  /** Running jobs that ran longer than the hard limit. */
  timedOut: number;
  /** Waiting Dynamic jobs no capable runner claimed within the deadline (#195). */
  noCapableRunner: number;
};

export type RunnerJobsRepositoryOptions = {
  now?: () => Date;
  /** The random lease token of a claim (256 bits by default). */
  newToken?: () => string;
  /** #320: the per-job credential of a claim made with `workerCredential`; tests only. */
  newCredential?: () => string;
  limits?: Partial<JobQueueLimits>;
  /**
   * #277: called for every job a claim refused for the entitlements of its workspace (suspended, a limit used
   * up, entitlements that cannot be read), after the transaction of the claim committed. The job is `failed`
   * already; this is only for the log. A callback that throws is logged (`claim_refusal_log_failed`) and
   * ignored: it can never fail the claim or orphan a job that was claimed in the same call.
   */
  onRefused?: (refusal: ClaimRefusal) => void;
  /**
   * #277: called once per claim and workspace whose entitlements hold a cost limit next to the own key, which
   * nothing reads (an entry stored before that shape was refused on write). Same rules as `onRefused`.
   */
  onIgnoredCostLimit?: (workspaceId: string) => void;
  /**
   * #361: called once for every usage record that settled without a known cost, after the transaction that settled
   * it committed. A cost limit does not bound such a run, so this is the signal to watch them: ids only, never a
   * figure or a name. Same rules as `onRefused` (a callback that throws is logged and ignored).
   */
  onUnknownCostSettled?: (settlement: UnknownCostSettlement) => void;
  /**
   * #487: called once per call that ended the claims of jobs for good, with the ids of the jobs, after the transaction
   * that ended them committed: a result, a failure or a cancel reported by the holder, a job given back on its last
   * attempt, a heartbeat past the hard limit, and the leases and runtimes that ran out and ended the job (in
   * `expireStaleJobs` and in the expiry step of a claim). The running server tells the Dispatcher to stop those jobs'
   * VMs. A job that went back to the queue is **not** named: the Dispatcher stops by job, and the next attempt's VM may
   * exist by the time the call arrives; the VM of the lost attempt lives until its own timeout or the job's final stop (the reaper
   * ends it earlier only while the retry is not `running`). Same rules as
   * `onRefused`: a callback that throws is logged and ignored, and a repository that joined a caller's transaction calls
   * it never (it cannot see the commit).
   */
  onClaimsEnded?: (jobIds: readonly string[]) => void;
};

/**
 * What a refused job looks like (#277): failed with the code, and as if it never started: no holder, no start
 * time and no lease, so the Runs list shows no duration for a run that "did not start". No attempt is counted.
 */
function refusedJob(errorCode: string, current: Date) {
  const timestamp = formatTimestamp(current);
  return {
    status: "failed",
    error_code: errorCode,
    runner_id: null,
    lease_token: null,
    claimed_at: null,
    heartbeat_at: null,
    lease_expires_at: null,
    finished_at: timestamp,
    updated_at: timestamp,
  } as const;
}

/** Runs a callback of the queue; one that throws is reported by the given stable code, without its message. */
function notify(code: string, callback: () => void): void {
  try {
    callback();
  } catch {
    console.error(`[queue] ${code}`);
  }
}

/** How many jobs one `claimNext` may refuse before it answers "nothing" and lets the runner ask again. */
const MAX_REFUSED_PER_CLAIM = 25;

export type RunnerJobsRepository = {
  /**
   * Expires stale leases and runtimes, then hands the oldest due job the runner's engines can run to
   * the runner (or null). `engines` defaults to `pr-agent` for a previous-release caller that sends
   * no capability list. The result carries the lease token the runner must present from then on.
   */
  claimNext(
    runnerId: string,
    engines?: readonly RunnerEngine[],
    claimOptions?: ClaimOptions,
  ): Promise<ClaimResult>;
  /**
   * #320: the job `leaseToken` was issued for, whatever its status: the claim that is running, or the
   * claim that ended (the token stays on a finished job, so a late or repeated report is recognised).
   * `undefined` for any other token, including the one of an earlier claim of a job that was queued
   * again. Reads only; the Worker API tells a credential that is not the job's (401) from a job that
   * ended (409) with it.
   */
  holding(jobId: string, leaseToken: string): Promise<Job | undefined>;
  /**
   * #320: counts one fetch of the job details by the Worker of the running claim `leaseToken`
   * belongs to, in one statement, up to `limit` per claim (the claim resets the count).
   */
  countFetch(
    jobId: string,
    leaseToken: string,
    limit: number,
  ): Promise<CountFetchResult>;
  /**
   * Extends the lease of the claim `leaseToken` belongs to. A job past the hard limit is failed with
   * `timeout` by this call and answers `not_holder`.
   */
  heartbeat(jobId: string, leaseToken: string): Promise<HeartbeatResult>;
  /** Finishes the claim `leaseToken` belongs to. Reporting the same outcome again is not an error. */
  complete(
    jobId: string,
    leaseToken: string,
    outcome: JobOutcome,
  ): Promise<CompleteResult>;
  /**
   * Gives a claimed job back. It counts as a lost attempt, exactly like a lapsed lease: the job is
   * waiting again (at `retryAt`, default now), or failed with `reason` if it was the last allowed
   * attempt. A turn of the Implementer is never run twice, so its first lost attempt is its last, unless the caller says
   * `beforeStart`: the input of the job never reached a Worker (the claim could not build it), nothing ran and nothing was
   * pushed, so the job waits again like any other and only the general cap applies (#753).
   */
  release(
    jobId: string,
    leaseToken: string,
    reason: string,
    options?: ReleaseOptions,
  ): Promise<ReleaseResult>;
  /**
   * A job by its id, whatever its workspace: the runner API answers "no such job" before it looks at
   * a lease token.
   */
  get(id: string): Promise<Job | undefined>;
  /**
   * #397: notes that the holder of the running claim `leaseToken` belongs to understands that its run can be
   * superseded. One statement fenced by the token; false for any other token or a job that is not running.
   */
  noteSupersede(jobId: string, leaseToken: string): Promise<boolean>;
  /** Deals with leases and runtimes that ran out. `claimNext` does this first on every call. */
  expireStaleJobs(): Promise<ExpiryReport>;
  /**
   * #328: fails every queued job that has waited `waitedMs` or longer, counted from the later of the time it
   * became due and the time it was last queued (a job given back after a lost lease starts waiting again), with
   * the stable code `dispatch_unavailable`. No attempt is counted. A job whose dispatch a Dispatcher
   * acknowledged and that is still inside the acknowledgement window is spared: that Dispatcher is working on
   * it. Returns how many jobs it failed.
   */
  failUndispatched(waitedMs: number): Promise<number>;
  /** #328: how many jobs are running now, of any runner or pool. */
  countRunning(): Promise<number>;
  /**
   * Cancels one claimed job with `errorCode`, in one statement keyed on the job id and the lease token
   * of the claim (running -> cancelled). The attempt count is not touched and the job is never queued
   * in between. `not_holder` when the caller does not hold the job (any more).
   */
  cancelClaimed(
    jobId: string,
    leaseToken: string,
    errorCode: JobErrorCode,
  ): Promise<CancelClaimedResult>;
};

/** How a claim is made. */
export type ClaimOptions = {
  /**
   * #320: mint a per-job credential for the claim (256 bits, `crj_`). The queue stores only its hash
   * as the lease token of the claim and returns the credential once, as `credential`.
   */
  workerCredential?: boolean;
  /**
   * #322: claim exactly this job (a Dispatcher woken by the dispatch webhook). Every other rule of the
   * claim applies to it unchanged; a job that cannot be claimed gives `null`.
   */
  jobId?: string;
  /**
   * #322: the pool cap. The pool is the runner id of the claim: when that many jobs with this runner id
   * are running, the claim gives `null`. Counted inside the claim transaction, after lapsed leases were
   * dealt with: see `claimNext`.
   */
  maxRunning?: number;
  /**
   * #397: the caller understands that its run can be superseded (the claim named the feature `supersede`). A running
   * job is superseded by a newer push only then; a Worker says so with its job details request instead
   * (`noteSupersede`).
   */
  acceptsSupersede?: boolean;
};

/** Which running jobs an attempt-losing statement applies to. */
type RunningScope = {
  /** Only jobs whose lease ran out at or before this timestamp. */
  leaseExpiredBefore?: string;
  /** Only this job, and only while `leaseToken` is its current claim. */
  claim?: { jobId: string; leaseToken: string };
};

function runningWhere(scope: RunningScope) {
  return (eb: ExpressionBuilder<Database, "jobs">) =>
    eb.and([
      eb("status", "=", "running"),
      ...(scope.leaseExpiredBefore === undefined
        ? []
        : [eb("lease_expires_at", "<=", scope.leaseExpiredBefore)]),
      ...(scope.claim === undefined
        ? []
        : [
            eb("id", "=", scope.claim.jobId),
            eb("lease_token", "=", scope.claim.leaseToken),
          ]),
    ]);
}

/**
 * The codes with which `expire` ends a claimed job without any word from its runner: the lease ran out, the runtime passed the
 * hard limit, the command was removed. A job that ended with one of them is no proof that a runner worked (#752), unlike a job the
 * runner finished or failed itself.
 */
const REAPER_ERROR_CODES = [
  "lease_expired",
  "timeout",
  "command_removed",
] as const satisfies readonly JobErrorCode[];

/** A start credit a claim granted: logged after the claim committed (#507). */
type GrantedStartCredit = { workspaceId: string; amountMicroUsd: number };

export function createRunnerJobsRepository(
  db: Kysely<Database>,
  options: RunnerJobsRepositoryOptions = {},
): RunnerJobsRepository {
  const now = options.now ?? (() => new Date());
  const newToken = options.newToken ?? newLeaseToken;
  const newCredential = options.newCredential ?? newWorkerCredential;
  const limits = { ...DEFAULT_JOB_QUEUE_LIMITS, ...options.limits };
  /**
   * Whether a running job was claimed longer ago than its hard limit allows (#752): a turn of the Implementer has its own,
   * longer one (`implementerMaxRuntimeMs`), every other kind keeps `maxRuntimeMs`.
   */
  const pastHardLimit =
    (current: Date) => (eb: ExpressionBuilder<Database, "jobs">) =>
      eb.or([
        eb.and([
          eb("review_kind", "<>", "implementer"),
          eb(
            "claimed_at",
            "<=",
            formatTimestamp(new Date(current.getTime() - limits.maxRuntimeMs)),
          ),
        ]),
        eb.and([
          eb("review_kind", "=", "implementer"),
          eb(
            "claimed_at",
            "<=",
            formatTimestamp(
              new Date(current.getTime() - limits.implementerMaxRuntimeMs),
            ),
          ),
        ]),
      ]);
  // The transaction guard already holds the exclusive gate lock; read without taking another lock
  // after job rows. This keeps every transition on the documented gate-before-rows order.
  async function dynamicReviewAllowed(
    executor: Kysely<Database>,
  ): Promise<boolean> {
    return (
      (await createInstanceSettingsRepository(executor).get("dynamic_review"))
        ?.enabled === true
    );
  }

  // A transaction cannot start another one; inside one, just use it.
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    const guarded = async (trx: Kysely<Database>) => {
      // The first lock, before any job row: disable and every runner transition serialize here.
      await lockDynamicReviewGate(trx, true);
      return run(trx);
    };
    return db.isTransaction ? guarded(db) : db.transaction().execute(guarded);
  }

  /**
   * A transaction that collects the runs it settled without a known cost and reports them once it committed
   * (#361): the alert never fires for a transaction that rolled back. Only the repository that opens the transaction
   * itself reports: one built on a database that is already a transaction (`db.isTransaction`) joins its caller's
   * transaction, whose commit it cannot see, so it reports nothing rather than something that may be rolled back.
   */
  async function inAlertingTransaction<T>(
    run: (
      executor: Kysely<Database>,
      unknownCost: UnknownCostSettlement[],
      endedClaims: string[],
    ) => Promise<T>,
  ): Promise<T> {
    const unknownCost: UnknownCostSettlement[] = [];
    const endedClaims: string[] = [];
    const result = await inTransaction((trx) =>
      run(trx, unknownCost, endedClaims),
    );
    if (db.isTransaction) return result;
    for (const settlement of unknownCost)
      notify("unknown_cost_callback_failed", () =>
        options.onUnknownCostSettled?.(settlement),
      );
    if (endedClaims.length > 0)
      notify("claims_ended_callback_failed", () =>
        options.onClaimsEnded?.(endedClaims),
      );
    return result;
  }

  /**
   * One attempt of a running job is lost (its lease ran out, or its holder gave it back). This is the
   * single rule for that: on the last allowed attempt the job fails with `errorCode`, otherwise it
   * goes back to the queue and its holder is dropped. Runner and claim time stay on a failed job (and
   * so does the lease token), so a late report from the old holder is recognised and refused.
   */
  async function loseAttempt(
    executor: Kysely<Database>,
    scope: RunningScope,
    errorCode: string,
    timestamp: string,
    runAfter?: string,
    /** #753: the input of the job never reached a Worker; the rule that a turn is never run twice does not apply. */
    beforeStart = false,
  ): Promise<{ failed: number; requeued: number }> {
    let disabled = 0;
    if (!(await dynamicReviewAllowed(executor))) {
      const result = await executor
        .updateTable("jobs")
        .set((eb) => ({
          status: "failed",
          attempts: eb("attempts", "+", 1),
          error_code: "dynamic_review_disabled" satisfies JobErrorCode,
          lease_expires_at: null,
          finished_at: timestamp,
          updated_at: timestamp,
        }))
        .where(runningWhere(scope))
        .where("review_kind", "=", "dynamic")
        .executeTakeFirst();
      disabled = Number(result.numUpdatedRows);
    }
    const failed = await executor
      .updateTable("jobs")
      .set((eb) => ({
        status: "failed",
        attempts: eb("attempts", "+", 1),
        error_code: errorCode,
        lease_expires_at: null,
        finished_at: timestamp,
        updated_at: timestamp,
      }))
      .where(runningWhere(scope))
      // #752: a turn of the Implementer is never run twice, so its first lost attempt is the last: it fails here instead of
      // waiting again (a second run would meet the branch the first one pushed).
      .where((eb) =>
        eb.or([
          eb("attempts", ">=", limits.maxAttempts - 1),
          ...(beforeStart
            ? []
            : [
                eb.and([
                  eb("review_kind", "=", "implementer"),
                  eb("attempts", ">=", IMPLEMENTER_MAX_ATTEMPTS - 1),
                ]),
              ]),
        ]),
      )
      .executeTakeFirst();

    const requeued = await executor
      .updateTable("jobs")
      .set((eb) => ({
        status: "queued",
        attempts: eb("attempts", "+", 1),
        runner_id: null,
        lease_token: null,
        claimed_at: null,
        heartbeat_at: null,
        lease_expires_at: null,
        ...(runAfter === undefined ? {} : { run_after: runAfter }),
        updated_at: timestamp,
      }))
      .where(runningWhere(scope))
      .executeTakeFirst();

    // #752: a turn that failed here has no report to come; its session is idle again.
    if (disabled + Number(failed.numUpdatedRows) > 0)
      await idleSessionsOfEndedTurns(executor, timestamp);
    return {
      failed: disabled + Number(failed.numUpdatedRows),
      requeued: Number(requeued.numUpdatedRows),
    };
  }

  /**
   * Cancels every removed command (#203) that is still waiting or whose running lease ran out. Such
   * a row can never be executed again, so it must not occupy its pull request or be requeued. The
   * job keeps its id, command, args, actor, attempts and results; only the status, the error code
   * and the timestamps change.
   */
  async function cancelRemovedCommands(
    executor: Kysely<Database>,
    timestamp: string,
  ): Promise<number> {
    const waiting = await executor
      .updateTable("jobs")
      .set({
        status: "cancelled",
        error_code: "command_removed" satisfies JobErrorCode,
        runner_id: null,
        lease_token: null,
        claimed_at: null,
        heartbeat_at: null,
        lease_expires_at: null,
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where("status", "=", "queued")
      .where("command", "!=", "review")
      .executeTakeFirst();
    const expired = await executor
      .updateTable("jobs")
      .set({
        status: "cancelled",
        error_code: "command_removed" satisfies JobErrorCode,
        lease_expires_at: null,
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where("status", "=", "running")
      .where("command", "!=", "review")
      .where("lease_expires_at", "<=", timestamp)
      .executeTakeFirst();
    return Number(waiting.numUpdatedRows) + Number(expired.numUpdatedRows);
  }

  /** Fails running jobs that were claimed longer ago than the hard limit allows. */
  async function failTimedOut(
    executor: Kysely<Database>,
    scope: RunningScope,
    current: Date,
  ): Promise<number> {
    const timestamp = formatTimestamp(current);
    const result = await executor
      .updateTable("jobs")
      .set({
        status: "failed",
        error_code: "timeout" satisfies JobErrorCode,
        lease_expires_at: null,
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where(runningWhere(scope))
      .where(pastHardLimit(current))
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /**
   * #195 (finding 1): a Dynamic job no capable runner claims within the deadline would wait forever (#752: so would a turn of
   * the Implementer, which only a runner with its own engine claims),
   * because eligibility excludes it and expiry only handles running jobs. It is cancelled (not failed
   * for a review reason), with the stable code `no_capable_runner`, without an attempt and without a
   * credential. The deadline is operator-owned (`noCapableRunnerMs`).
   *
   * #752 review: the code says there is no capable runner, so a busy one must not trigger it. A job of the same kind that is
   * running, or that a runner claimed and ended itself within the deadline, shows the pool of that engine is alive; the queue then keeps the
   * job until the absolute limit (`noCapableRunnerAbsoluteMs`). Every job of this database counts, whatever its workspace: the runner
   * pool is shared. What is no sign of a runner: a job that ended without a claim (`claimed_at` is null, such as one cancelled here), a
   * job the reaper ended (`REAPER_ERROR_CODES`), and a `running` row whose lease or runtime is spent, which is why `expire` runs this pass
   * after `loseAttempt` and `failTimedOut`. An operator's deadline longer than the absolute limit wins: the job goes at the deadline.
   */
  async function cancelStrandedDynamic(
    executor: Kysely<Database>,
    current: Date,
  ): Promise<number> {
    const timestamp = formatTimestamp(current);
    const strandedBefore = formatTimestamp(
      new Date(current.getTime() - limits.noCapableRunnerMs),
    );
    const absoluteBefore = formatTimestamp(
      new Date(current.getTime() - limits.noCapableRunnerAbsoluteMs),
    );
    const result = await executor
      .updateTable("jobs")
      .set({
        status: "cancelled",
        error_code: "no_capable_runner" satisfies JobErrorCode,
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where("status", "=", "queued")
      .where("review_kind", "in", ["dynamic", "implementer"])
      // A claimed job follows the lease/attempt policy, never this initial capability deadline.
      .where("attempts", "=", 0)
      .where("created_at", "<=", strandedBefore)
      .where("run_after", "<=", strandedBefore)
      .where((eb) =>
        eb.or([
          eb.and([
            eb("created_at", "<=", absoluteBefore),
            eb("run_after", "<=", absoluteBefore),
          ]),
          eb.not(
            eb.exists(
              eb
                .selectFrom("jobs as served")
                .select("served.id")
                .whereRef("served.review_kind", "=", "jobs.review_kind")
                .where((served) =>
                  served.or([
                    // Running: the passes of `expire` ran before, so a lapsed lease or a spent runtime is not `running` any more.
                    served("served.status", "=", "running"),
                    // Ended after a claim, through the runner: a job the reaper ended says nothing about a runner.
                    served.and([
                      served("served.claimed_at", "is not", null),
                      served("served.finished_at", ">", strandedBefore),
                      served.or([
                        served("served.error_code", "is", null),
                        served("served.error_code", "not in", [
                          ...REAPER_ERROR_CODES,
                        ]),
                      ]),
                    ]),
                  ]),
                ),
            ),
          ),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /**
   * #487: the running jobs whose claim the passes of `expire` act on: the lease ran out or the runtime is past the hard
   * limit. Read after the rows were reserved and before the passes change them, so it is the set they act on.
   */
  async function claimsEndingByExpiry(
    executor: Kysely<Database>,
    current: Date,
  ): Promise<string[]> {
    const timestamp = formatTimestamp(current);
    const rows = await executor
      .selectFrom("jobs")
      .select("id")
      .where("status", "=", "running")
      .where((eb) =>
        eb.or([
          eb("lease_expires_at", "<=", timestamp),
          pastHardLimit(current)(eb),
        ]),
      )
      .execute();
    return rows.map((row) => row.id);
  }

  async function expire(
    executor: Kysely<Database>,
    current: Date,
    unknownCost: UnknownCostSettlement[],
    endedClaims: string[],
  ): Promise<ExpiryReport> {
    const timestamp = formatTimestamp(current);
    // Before the expiry passes or claim: reserve all live candidates in the same row order. The
    // exclusive gate prevents another queue writer from inserting/changing that set meanwhile.
    await lockJobRowsInOrder(
      executor,
      executor
        .selectFrom("jobs")
        .select("id")
        .where("status", "in", ["queued", "running"]),
    );
    const expiring = await claimsEndingByExpiry(executor, current);
    if (!(await dynamicReviewAllowed(executor))) {
      await executor
        .updateTable("jobs")
        .set({
          status: "cancelled",
          error_code: "dynamic_review_disabled" satisfies JobErrorCode,
          finished_at: timestamp,
          updated_at: timestamp,
        })
        .where("status", "=", "queued")
        .where("review_kind", "=", "dynamic")
        .execute();
    }
    // Removed commands (#203) never run again. A waiting row may still appear after the data
    // migration (a race); a running one was claimed before the upgrade. They are cancelled here so
    // they can neither starve review jobs nor be requeued.
    await cancelRemovedCommands(executor, timestamp);
    const lost = await loseAttempt(
      executor,
      { leaseExpiredBefore: timestamp },
      "lease_expired" satisfies JobErrorCode,
      timestamp,
    );
    // A job whose runner keeps the lease alive but never finishes. Lost leases come first: a job
    // whose runner vanished long ago is retried, not failed for taking long.
    const timedOut = await failTimedOut(executor, {}, current);
    // A Dynamic job no runner can run must not wait forever (#195). After the two passes above on purpose (#752): a row whose
    // lease lapsed or whose runtime ran out is not `running` any more, so it is no sign of a live runner here.
    const noCapableRunner = await cancelStrandedDynamic(executor, current);
    unknownCost.push(...(await closeRecordsOfEndedJobs(executor, timestamp)));
    // Only the jobs that are over: one that went back to the queue gets a new claim, and its VM must not be stopped.
    if (expiring.length > 0)
      endedClaims.push(
        ...(
          await executor
            .selectFrom("jobs")
            .select("id")
            .where("id", "in", expiring)
            .where("status", "<>", "queued")
            .execute()
        ).map((row) => row.id),
      );
    return {
      requeued: lost.requeued,
      leaseExpired: lost.failed,
      timedOut,
      noCapableRunner,
    };
  }

  /** #328: the queued jobs that waited for a claim longer than `waitedMs`; see `failUndispatched`. */
  async function failUndispatched(
    executor: Kysely<Database>,
    current: Date,
    waitedMs: number,
    unknownCost: UnknownCostSettlement[],
  ): Promise<number> {
    const timestamp = formatTimestamp(current);
    const waitedBefore = formatTimestamp(
      new Date(current.getTime() - waitedMs),
    );
    const waiting = (eb: ExpressionBuilder<Database, "jobs">) =>
      eb.and([
        eb("status", "=", "queued"),
        // Due for that long, and queued (again) for that long: a requeue changes `updated_at`, not `run_after`.
        eb("run_after", "<=", waitedBefore),
        eb("updated_at", "<=", waitedBefore),
        eb.not(
          eb.exists(
            eb
              .selectFrom("job_dispatches")
              .select("job_dispatches.job_id")
              .whereRef("job_dispatches.job_id", "=", "jobs.id")
              .where("job_dispatches.state", "=", "acked")
              .where("job_dispatches.next_dispatch_at", ">", timestamp),
          ),
        ),
      ]);
    await lockJobRowsInOrder(
      executor,
      executor.selectFrom("jobs").select("id").where(waiting),
    );
    const result = await executor
      .updateTable("jobs")
      .set({
        status: "failed",
        error_code: "dispatch_unavailable" satisfies JobErrorCode,
        finished_at: timestamp,
        updated_at: timestamp,
      })
      .where(waiting)
      .executeTakeFirst();
    unknownCost.push(...(await closeRecordsOfEndedJobs(executor, timestamp)));
    return Number(result.numUpdatedRows);
  }

  /** #322: the running jobs of one pool (the runner id of their claim). */
  async function runningInPool(
    executor: Kysely<Database>,
    runnerId: string,
  ): Promise<number> {
    const { count } = await executor
      .selectFrom("jobs")
      .select((eb) => eb.fn.countAll<number | string>().as("count"))
      .where("status", "=", "running")
      .where("runner_id", "=", runnerId)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /**
   * #277: ends the job this claim just took as `failed` with the code of the refusal, in the transaction of the
   * claim. No attempt is counted and no runner heard of it; its record, if it had one, is voided by the caller.
   */
  async function refuseClaimedJob(
    executor: Kysely<Database>,
    jobId: string,
    errorCode: string,
    current: Date,
  ): Promise<void> {
    await executor
      .updateTable("jobs")
      .set(refusedJob(errorCode, current))
      .where("id", "=", jobId)
      .where("status", "=", "running")
      .execute();
    await idleSessionsOfEndedTurns(executor, formatTimestamp(current));
  }

  /**
   * #277: a refusal that does not depend on the job (a suspension, entitlements that cannot be read) ends the
   * claimed job and every other due job of the workspace in one statement, so a backlog does not take one round
   * of the claim per job and does not hold the gate lock for as many. Returns the ids it ended.
   */
  async function refuseDueJobsOfWorkspace(
    executor: Kysely<Database>,
    workspaceId: string,
    claimedJobId: string,
    errorCode: string,
    current: Date,
  ): Promise<
    Array<{
      id: string;
      repository_id: string;
      pr_number: number;
      trigger_kind: string;
      review_kind: string;
    }>
  > {
    const rows = await executor
      .updateTable("jobs")
      .set(refusedJob(errorCode, current))
      .where("workspace_id", "=", workspaceId)
      .where((eb) =>
        eb.or([
          eb.and([eb("id", "=", claimedJobId), eb("status", "=", "running")]),
          eb.and([
            eb("status", "=", "queued"),
            eb("command", "=", "review"),
            eb("run_after", "<=", formatTimestamp(current)),
          ]),
        ]),
      )
      .returning([
        "id",
        "repository_id",
        "pr_number",
        "trigger_kind",
        "review_kind",
      ])
      .execute();
    await idleSessionsOfEndedTurns(executor, formatTimestamp(current));
    return rows;
  }

  return {
    async claimNext(runnerId, engines = DEFAULT_ENGINES, claimOptions = {}) {
      const refusals: ClaimRefusal[] = [];
      const ignoredCostLimits = new Set<string>();
      const grantedCredits: GrantedStartCredit[] = []; // #507: logged after the commit
      const claimed = await inAlertingTransaction(
        async (trx, unknownCost, endedClaims) => {
          const current = now();
          await expire(trx, current, unknownCost, endedClaims);
          // The credential is only ever returned; the database gets its hash as the lease token.
          const credential =
            claimOptions.workerCredential === true
              ? newCredential()
              : undefined;
          const leaseToken =
            credential === undefined
              ? newToken()
              : workerLeaseToken(credential);
          const claim = {
            runnerId,
            leaseToken,
            now: current,
            leaseExpiresAt: new Date(current.getTime() + limits.leaseMs),
            ...(claimOptions.acceptsSupersede === true
              ? { acceptsSupersede: true }
              : {}),
          };
          const reviewKinds = reviewKindsForEngines(engines);
          // #746: a caller whose engines run no kind this queue holds (the Implementer's engine, until its jobs are queued, #752)
          // gets nothing, and the statement is not built with an empty list of kinds.
          if (reviewKinds.length === 0) return null;
          // #498: read at most once per claim, and only when a job passes the admission; a claim that finds no job reads nothing.
          let billing: ClaimBilling | undefined;
          const startCreditTried = new Set<string>();
          // #322: the pool cap. Atomic because a claim is the only way a job becomes running and every
          // claim runs under the exclusive gate lock of `inTransaction`: two claims of one pool cannot both count below the cap and then both
          // claim. The count follows `expire`, so a lapsed lease does not hold a slot.
          if (
            claimOptions.maxRunning !== undefined &&
            (await runningInPool(trx, runnerId)) >= claimOptions.maxRunning
          )
            return null;
          for (let refused = 0; refused < MAX_REFUSED_PER_CLAIM; refused += 1) {
            const row = await claimOldestDueJob(
              trx,
              claim,
              reviewKinds,
              claimOptions.jobId,
            );
            if (row === undefined) return null;
            // #498: read once per claim, for the first job that is taken (a claim that finds no job reads nothing). #499
            // needs it before the admission: while billing is on, the run quotas of the plan are not enforced.
            billing ??= await readClaimBilling(trx);
            // #277: the limits and the suspension of the job's workspace, decided in this transaction, before
            // the record is reserved: a refused job leaves no record, and two claims cannot both take the
            // last unit of a limit.
            const { admission, hadRecord, ignoredCostLimit, keyMode } =
              await admitClaimedJob(trx, row, () => current, {
                runQuotas: billing.state !== "on",
                // #496: the key mode follows the workspace's choice while billing is on.
                billingOn: billing.state === "on",
              });
            if (ignoredCostLimit) ignoredCostLimits.add(row.workspace_id);
            if (!admission.allow) {
              const detail = {
                ...(admission.detail === undefined
                  ? {}
                  : { detail: admission.detail }),
                ...(admission.periodStart === undefined
                  ? {}
                  : { periodStart: admission.periodStart }),
              };
              if (isJobIndependentRefusal(admission.errorCode)) {
                const ended = await refuseDueJobsOfWorkspace(
                  trx,
                  row.workspace_id,
                  row.id,
                  admission.errorCode,
                  current,
                );
                // Any of them may have had a record that counted (claimed before, lost its lease).
                unknownCost.push(
                  ...(await closeRecordsOfEndedJobs(
                    trx,
                    formatTimestamp(current),
                  )),
                );
                for (const job of ended)
                  refusals.push({
                    jobId: job.id,
                    workspaceId: row.workspace_id,
                    repositoryId: job.repository_id,
                    prNumber: job.pr_number,
                    triggerKind: job.trigger_kind,
                    reviewKind: jobKindOf(job.review_kind),
                    errorCode: admission.errorCode,
                    ...detail,
                  });
                continue;
              }
              await refuseClaimedJob(trx, row.id, admission.errorCode, current);
              // A job claimed again after a lost lease had a record that counted: it ends with the job.
              if (hadRecord)
                unknownCost.push(
                  ...(await closeRecordsOfEndedJobs(
                    trx,
                    formatTimestamp(current),
                  )),
                );
              refusals.push({
                jobId: row.id,
                workspaceId: row.workspace_id,
                repositoryId: row.repository_id,
                prNumber: row.pr_number,
                triggerKind: row.trigger_kind,
                reviewKind: jobKindOf(row.review_kind),
                errorCode: admission.errorCode,
                ...detail,
              });
              continue;
            }
            // #499: while billing is on, the hidden hourly brake and the workspace's monthly limit come after the admission and
            // before the balance. They never fail the claim (their savepoint turns a failure into a refusal of this job).
            const capped: CapOutcome =
              billing.state === "on"
                ? await checkClaimCaps(trx, {
                    hourlyReviewLimit: billing.hourlyReviewLimit,
                    job: { id: row.id, workspaceId: row.workspace_id },
                    now: () => current,
                  })
                : { ok: true };
            // #499: a limit that could not be read for now (a deadlock, a timeout, a busy database) is no verdict on the job: it goes
            // back to the queue like a lost attempt, due again after CLAIM_CAPS_RETRY_MS, and fails (closed) only when its attempts
            // are used up. The pass ends here, so a database in trouble is not asked again while this transaction holds the gate lock;
            // the job is not due for the next pass, so it does not block the queue head.
            if (!capped.ok && capped.transient === true) {
              const lost = await loseAttempt(
                trx,
                { claim: { jobId: row.id, leaseToken } },
                capped.code,
                formatTimestamp(current),
                formatTimestamp(
                  new Date(current.getTime() + CLAIM_CAPS_RETRY_MS),
                ),
              );
              if (lost.failed > 0) {
                if (hadRecord)
                  unknownCost.push(
                    ...(await closeRecordsOfEndedJobs(
                      trx,
                      formatTimestamp(current),
                    )),
                  );
                const ended = await trx
                  .selectFrom("jobs")
                  .select("error_code")
                  .where("id", "=", row.id)
                  .executeTakeFirstOrThrow();
                const noticeKey = headNoticeKey(row.head_sha);
                refusals.push({
                  jobId: row.id,
                  workspaceId: row.workspace_id,
                  repositoryId: row.repository_id,
                  prNumber: row.pr_number,
                  triggerKind: row.trigger_kind,
                  reviewKind: jobKindOf(row.review_kind),
                  errorCode: ended.error_code ?? capped.code,
                  ...(noticeKey === undefined
                    ? {}
                    : { periodStart: noticeKey }),
                });
              }
              return null;
            }
            // #605: while billing is on, the balance check comes after the admission and before the record, in the same
            // transaction: a refused job leaves no record, and no job takes a hold (the price is charged when it ends).
            // Billing off reads no billing table.
            // #507: the start credit comes first, in this transaction, so the first job of a new workspace can use it. It is
            // granted once per GitHub account and only while billing is on and ready (a state that is not "on" reads nothing),
            // and not for a job a limit refused. It never fails the claim (a failed grant is skipped and logged), and a
            // workspace is tried once per claim: a refused job's workspace meets its next candidate job with the same answer.
            if (
              billing.state === "on" &&
              capped.ok &&
              !startCreditTried.has(row.workspace_id)
            ) {
              startCreditTried.add(row.workspace_id);
              const credit = await ensureStartCreditWhileOn(
                trx,
                row.workspace_id,
                () => current,
              );
              if (credit.status === "granted")
                grantedCredits.push({
                  workspaceId: row.workspace_id,
                  amountMicroUsd: credit.entry.amountMicroUsd,
                });
            }
            const held: AdmitOutcome | CapOutcome = !capped.ok
              ? capped
              : billing.state === "off"
                ? { ok: true }
                : billing.state === "rates_incomplete"
                  ? RATES_INCOMPLETE_REFUSAL
                  : await admitAtClaim(trx, {
                      rates: billing.rates,
                      job: {
                        workspaceId: row.workspace_id,
                        reviewKind: jobKindOf(row.review_kind),
                      },
                      keyMode,
                      now: () => current,
                    });
            if (!held.ok) {
              await refuseClaimedJob(trx, row.id, held.code, current);
              // #506: a refusal for the balance tells the workspace that it is empty, once (the mail goes out after the commit).
              if (
                held.code === "insufficient_balance" ||
                held.code === "balance_negative"
              )
                await noteRefusalForBalance(trx, {
                  workspaceId: row.workspace_id,
                  now: () => current,
                });
              // A job claimed again after a lost lease had a record and a hold that counted: they end with the job.
              if (hadRecord)
                unknownCost.push(
                  ...(await closeRecordsOfEndedJobs(
                    trx,
                    formatTimestamp(current),
                  )),
                );
              const noticeKey = headNoticeKey(row.head_sha);
              refusals.push({
                jobId: row.id,
                workspaceId: row.workspace_id,
                repositoryId: row.repository_id,
                prNumber: row.pr_number,
                triggerKind: row.trigger_kind,
                reviewKind: jobKindOf(row.review_kind),
                errorCode: held.code,
                ...(noticeKey === undefined ? {} : { periodStart: noticeKey }),
              });
              continue;
            }
            // The record is reserved in the transaction of the claim, so a job handed out always counts. It carries the key
            // mode this claim decided (#496): the Worker's fetch, a retry and the settlement read it from here and never
            // decide again. A job claimed again after a lost lease keeps its one record, and takes the mode of the new claim.
            const records = createUsageRecordsRepository(
              trx,
              row.workspace_id,
              () => current,
            );
            await records.reserve(row.id, keyMode);
            if (hadRecord) await records.setKeyMode(row.id, keyMode);
            // #605: the money of this job is settled when it ends, and only a job claimed with billing on is.
            if (billing.state === "on") await records.openBilling(row.id);
            return {
              job: toJob(row),
              leaseToken,
              ...(credential === undefined ? {} : { credential }),
            };
          }
          // Many jobs in a row were refused; the runner asks again.
          return null;
        },
      );
      // After the commit, and never able to fail it: a claimed job is already running under its lease. A claim inside the
      // transaction of a caller cannot see that commit: the caller's own code logs nothing for it.
      if (!db.isTransaction)
        for (const credit of grantedCredits)
          logStartCreditGranted(credit.workspaceId, credit.amountMicroUsd);
      for (const refusal of refusals)
        notify("claim_refusal_log_failed", () => options.onRefused?.(refusal));
      for (const workspaceId of ignoredCostLimits)
        notify("ignored_cost_limit_callback_failed", () =>
          options.onIgnoredCostLimit?.(workspaceId),
        );
      return claimed;
    },

    async holding(jobId, leaseToken) {
      const row = await db
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", jobId)
        .where("lease_token", "=", leaseToken)
        .executeTakeFirst();
      return row === undefined ? undefined : toJob(row);
    },

    countFetch(jobId, leaseToken, limit) {
      return inTransaction<CountFetchResult>(async (trx) => {
        const counted = await trx
          .updateTable("jobs")
          .set((eb) => ({ worker_fetches: eb("worker_fetches", "+", 1) }))
          .where(runningWhere({ claim: { jobId, leaseToken } }))
          .where("worker_fetches", "<", limit)
          .returning("id")
          .executeTakeFirst();
        if (counted !== undefined) return "counted";
        // Not counted: either the fetches are used up, or the caller does not hold the running claim.
        const held = await trx
          .selectFrom("jobs")
          .select("id")
          .where(runningWhere({ claim: { jobId, leaseToken } }))
          .executeTakeFirst();
        return held === undefined ? "not_holder" : "exhausted";
      });
    },

    heartbeat(jobId, leaseToken) {
      return inAlertingTransaction<HeartbeatResult>(
        async (trx, unknownCost, endedClaims) => {
          const current = now();
          const timestamp = formatTimestamp(current);
          // The hard limit does not depend on anyone else's claim: the holder that is past it learns
          // so here, and the job fails.
          const timedOut = await failTimedOut(
            trx,
            { claim: { jobId, leaseToken } },
            current,
          );
          if (timedOut > 0) {
            endedClaims.push(jobId);
            unknownCost.push(
              ...(await closeRecordsOfEndedJobs(trx, timestamp)),
            );
          }
          const row = await trx
            .updateTable("jobs")
            .set({
              heartbeat_at: timestamp,
              lease_expires_at: formatTimestamp(
                new Date(current.getTime() + limits.leaseMs),
              ),
              updated_at: timestamp,
            })
            .where(runningWhere({ claim: { jobId, leaseToken } }))
            .returningAll()
            .executeTakeFirst();
          if (row !== undefined) return { status: "ok", job: toJob(row) };
          // #397: a run a newer push replaced keeps its claim for the drain window, so its holder can finish the
          // requests in flight and report. It is told so; the lease is not extended.
          const superseded = await trx
            .selectFrom("jobs")
            .selectAll()
            .where("id", "=", jobId)
            .where("lease_token", "=", leaseToken)
            .where("status", "=", "superseded")
            .where("claimed_at", "is not", null)
            .where("result", "is", null)
            .where("lease_expires_at", ">", timestamp)
            .executeTakeFirst();
          return superseded === undefined
            ? { status: "not_holder" }
            : { status: "superseded", job: toJob(superseded) };
        },
      );
    },

    async noteSupersede(jobId, leaseToken) {
      const row = await db
        .updateTable("jobs")
        .set({ accepts_supersede: 1 })
        .where(runningWhere({ claim: { jobId, leaseToken } }))
        .returning("id")
        .executeTakeFirst();
      return row !== undefined;
    },

    complete(jobId, leaseToken, outcome) {
      const target: JobStatus = outcome.ok ? "succeeded" : "failed";
      const errorCode = outcome.ok ? null : outcome.errorCode;
      const result = outcome.result ?? null;
      return inAlertingTransaction<CompleteResult>(
        async (trx, unknownCost, endedClaims) => {
          const timestamp = formatTimestamp(now());
          const finished = await trx
            .updateTable("jobs")
            .set({
              status: target,
              result: result === null ? null : encodeJson(result),
              error_code: errorCode,
              lease_expires_at: null,
              finished_at: timestamp,
              updated_at: timestamp,
            })
            .where(runningWhere({ claim: { jobId, leaseToken } }))
            .returningAll()
            .executeTakeFirst();
          if (finished !== undefined) {
            endedClaims.push(jobId);
            // #754: the report of a turn gives its session the result (the pushed head, the summary, the saved agent session)
            // and sets it idle, in this transaction; a failure without a block records nothing but the end. Only the call that
            // ended the job gets here: a report that comes late for a settled job, or with a lost lease, changes nothing.
            if (finished.review_kind === "implementer")
              await recordTurnOfJob(trx, finished, result, now);
            // #752: the sessions of the other turns that ended without a report of their run are idle by now; this only makes
            // sure of it.
            await idleSessionsOfEndedTurns(trx, timestamp);
            // Settled from what the runner reported, in the same transaction as the job's end.
            const settlement = settlementOfOutcome(outcome);
            const settled = await createUsageRecordsRepository(
              trx,
              finished.workspace_id,
              now,
            ).settle(finished.id, settlement);
            // #498: the hold of the job is released and its price charged, in the transaction that ended it.
            await settleEndedJobs(trx, [finished.id], now);
            // #361: no cost limit bounds a run without a cost; it is reported so it can be watched (once: when this
            // call settled the record, not when it was settled already).
            if (
              settled &&
              settlement.state === "settled" &&
              settlement.costMicroUsd === null
            )
              unknownCost.push({
                workspaceId: finished.workspace_id,
                jobId: finished.id,
              });
            return { status: "completed", job: toJob(finished) };
          }

          // Not running any more: either this claim already reported (same or other outcome), or it
          // was lost, or it never existed.
          const row = await trx
            .selectFrom("jobs")
            .selectAll()
            .where("id", "=", jobId)
            .where("lease_token", "=", leaseToken)
            .executeTakeFirst();
          if (row === undefined) return { status: "not_holder" };
          const job = toJob(row);
          if (job.status === "superseded") {
            // #397: the report of a run a newer push replaced is stored once and settles its record (the cost it
            // measured is usage, the run is not counted as a run of the quota). The job stays `superseded`. Another
            // report, after the first, is judged by the same rule as for any job.
            if (row.claimed_at === null) return { status: "not_holder" };
            if (row.result !== null)
              return isDeepStrictEqual(job.result, result)
                ? { status: "already_completed", job }
                : { status: "outcome_conflict", job };
            const timestamp = formatTimestamp(now());
            // The claim lasts the drain window and the report is taken for a grace after it, the time before which
            // the sweep does not settle the record (`closeRecordsOfEndedJobs`). Later the record is (or may be)
            // settled with an unknown cost already, and a record is settled once: the report is refused, like a
            // heartbeat, instead of being stored with a cost that is not applied.
            if (
              row.lease_expires_at === null ||
              Date.parse(row.lease_expires_at) + SUPERSEDED_REPORT_GRACE_MS <=
                now().getTime()
            )
              return { status: "not_holder" };
            const stored = await trx
              .updateTable("jobs")
              .set({
                result: result === null ? null : encodeJson(result),
                updated_at: timestamp,
              })
              .where("id", "=", jobId)
              .where("lease_token", "=", leaseToken)
              .where("status", "=", "superseded")
              .where("result", "is", null)
              .returningAll()
              .executeTakeFirst();
            if (stored === undefined) return { status: "not_holder" };
            const settlement = settlementOfSupersededOutcome(outcome);
            const settled = await createUsageRecordsRepository(
              trx,
              stored.workspace_id,
              now,
            ).settle(stored.id, settlement);
            // The job of a superseded run keeps no error code; the one the Worker reports (ours or not) prices the run.
            await settleEndedJobs(trx, [stored.id], now, {
              reportedErrorCodes: new Map(
                outcome.ok ? [] : [[stored.id, outcome.errorCode]],
              ),
            });
            if (
              settled &&
              settlement.state === "settled" &&
              settlement.costMicroUsd === null
            )
              unknownCost.push({
                workspaceId: stored.workspace_id,
                jobId: stored.id,
              });
            endedClaims.push(jobId);
            return { status: "completed", job: toJob(stored) };
          }
          if (job.status !== "succeeded" && job.status !== "failed")
            return { status: "not_holder" };
          const sameOutcome =
            job.status === target &&
            job.errorCode === errorCode &&
            isDeepStrictEqual(job.result, result);
          return sameOutcome
            ? { status: "already_completed", job }
            : { status: "outcome_conflict", job };
        },
      );
    },

    release(jobId, leaseToken, reason, releaseOptions = {}) {
      return inAlertingTransaction<ReleaseResult>(
        async (trx, unknownCost, endedClaims) => {
          const timestamp = formatTimestamp(now());
          // A removed command (#203) that is given back is cancelled, never requeued: no attempt of it
          // may ever run again. Only the current holder (the lease token) may cancel it this way.
          const removed = await trx
            .updateTable("jobs")
            .set({
              status: "cancelled",
              error_code: "command_removed" satisfies JobErrorCode,
              lease_expires_at: null,
              finished_at: timestamp,
              updated_at: timestamp,
            })
            .where(runningWhere({ claim: { jobId, leaseToken } }))
            .where("command", "!=", "review")
            .returningAll()
            .executeTakeFirst();
          if (removed !== undefined) {
            endedClaims.push(jobId);
            unknownCost.push(
              ...(await closeRecordsOfEndedJobs(trx, timestamp)),
            );
            return { status: "cancelled", job: toJob(removed) };
          }
          const lost = await loseAttempt(
            trx,
            { claim: { jobId, leaseToken } },
            reason,
            timestamp,
            releaseOptions.retryAt === undefined
              ? undefined
              : formatTimestamp(releaseOptions.retryAt),
            releaseOptions.beforeStart === true,
          );
          if (lost.failed === 0 && lost.requeued === 0)
            return { status: "not_holder" };
          if (lost.failed > 0) endedClaims.push(jobId);
          unknownCost.push(...(await closeRecordsOfEndedJobs(trx, timestamp)));
          const row = await trx
            .selectFrom("jobs")
            .selectAll()
            .where("id", "=", jobId)
            .executeTakeFirstOrThrow();
          // #754: a turn whose runner was shut down after it pushed keeps what the runner reported; a turn that goes back to the
          // queue (never the Implementer's: one attempt) has not ended and records nothing.
          if (
            lost.failed > 0 &&
            row.review_kind === "implementer" &&
            releaseOptions.result !== undefined
          )
            await recordTurnOfJob(trx, row, releaseOptions.result, now);
          return lost.failed > 0
            ? { status: "failed", job: toJob(row) }
            : { status: "requeued", job: toJob(row) };
        },
      );
    },

    async get(id) {
      const row = await db
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toJob(row);
    },

    expireStaleJobs() {
      return inAlertingTransaction((trx, unknownCost, endedClaims) =>
        expire(trx, now(), unknownCost, endedClaims),
      );
    },

    failUndispatched(waitedMs) {
      return inAlertingTransaction((trx, unknownCost) =>
        failUndispatched(trx, now(), waitedMs, unknownCost),
      );
    },

    async countRunning() {
      const { count } = await db
        .selectFrom("jobs")
        .select((eb) => eb.fn.countAll<number | string>().as("count"))
        .where("status", "=", "running")
        .executeTakeFirstOrThrow();
      return Number(count);
    },

    cancelClaimed(jobId, leaseToken, errorCode) {
      return inAlertingTransaction<CancelClaimedResult>(
        async (trx, unknownCost, endedClaims) => {
          const timestamp = formatTimestamp(now());
          // Not a transition of the shared table (`canTransition`): `cancelWaiting` derives its statuses
          // from that table and a deactivation must never cancel running jobs. This one statement is the
          // only way a running job becomes cancelled, and only for the holder of the claim.
          const row = await trx
            .updateTable("jobs")
            .set({
              status: "cancelled",
              error_code: errorCode,
              lease_expires_at: null,
              finished_at: timestamp,
              updated_at: timestamp,
            })
            .where(runningWhere({ claim: { jobId, leaseToken } }))
            .returningAll()
            .executeTakeFirst();
          if (row === undefined) return { status: "not_holder" };
          endedClaims.push(jobId);
          unknownCost.push(...(await closeRecordsOfEndedJobs(trx, timestamp)));
          return { status: "cancelled", job: toJob(row) };
        },
      );
    },
  };
}
