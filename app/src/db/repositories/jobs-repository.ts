// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the jobs table of ONE workspace (the factory takes the workspace id; see
// ../workspace-scope.ts): creating jobs, dropping waiting ones, reading them. The lease side of the
// queue (claim, heartbeat, complete, release, expiry) is not scoped, because runners serve the whole
// instance: it lives in runner-jobs-repository.ts. Together they are the only code that reads or
// writes the table. The rules of the queue are described in `src/jobs/README.md`; they are enforced
// here and there, in transactions, so that two app instances (or an instance and a runner API
// handler) cannot interleave halfway.
//
// Every public operation that reads before it writes runs in one transaction. Transactions on this
// database take the write lock up front (`begin immediate`, see `dialect.ts`), so the check "is there
// a job already?" and the insert that follows it cannot be separated by another writer.
import "server-only";
import {
  lockDynamicReviewGate,
  lockJobRowsInOrder,
} from "../dynamic-review-lock.ts";
import type { Kysely, Selectable } from "kysely";
import {
  STORED_REVIEW_COMMANDS,
  type JsonValue,
} from "../../integrations/types.ts";
import { JOB_KINDS, type JobKind } from "../../job-kind/job-kind.ts";
import {
  implementerDeliveryId,
  implementerJobShape,
} from "../implementer-job-shape.ts";
import { JobQueueError } from "../../jobs/errors.ts";
import type { ValidEnqueueInput } from "../../jobs/job-input.ts";
import { ImplementerStoreError } from "../implementer-errors.ts";
import {
  createImplementerRepository,
  type NewImplementerTask,
} from "./implementer-repository.ts";
import {
  createInstanceDynamicReviewGate,
  type DynamicReviewGate,
} from "../../jobs/dynamic-review-gate.ts";
import {
  createStoredReviewKindResolver,
  type ReviewKindResolver,
} from "../../jobs/review-kind.ts";
import {
  SLOT_HOLDING_STATUSES,
  isJobStatus,
  statusesThatCanBecome,
  type JobStatus,
} from "../job-status.ts";
import {
  JOB_TRIGGER_KINDS,
  type EnqueueImplementerTurnInput,
  type EnqueueImplementerTurnResult,
  type EnqueueResult,
  type Job,
  type JobErrorCode,
} from "../../jobs/job-types.ts";
import { SUPERSEDED_DRAIN_MS } from "../supersede-timing.ts";
import { databaseDriver } from "../driver.ts";
import { decodeJson, formatTimestamp } from "../codecs.ts";
import { errorCode, UNIQUE_VIOLATION } from "../errors.ts";
import type { Database, JobsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import { settleEndedJobs } from "../../billing/settle-jobs.ts";
import { createUsageRecordsRepository } from "./usage-records-repository.ts";

export type JobListFilter = {
  repositoryId?: string;
  prNumber?: number;
  status?: JobStatus | JobStatus[];
  /** At most this many jobs, oldest first. Defaults to 100 and is capped at 500. */
  limit?: number;
};

export const JOB_LIST_DEFAULT_LIMIT = 100;
export const JOB_LIST_MAX_LIMIT = 500;

/** The most heads a claim names as attempted (#255); the contract bounds the list by the same number. */
export const MAX_ATTEMPTED_SHAS = 20;
// Rows read before the heads are made distinct; many reruns of one head must not hide an older one.
const ATTEMPTED_SCAN_LIMIT = 200;

/**
 * The heads a claim names as attempted (#255), newest first and bounded. `truncated` (#257) says that
 * more distinct heads qualified than `shas` holds, or that the scan filled up before it could tell.
 */
export type AttemptedShas = { shas: string[]; truncated: boolean };

/** The lookup of the last reviewed head for one pull request and review kind (#199). */
export type PreviousReviewedShaInput = {
  repositoryId: string;
  prNumber: number;
  reviewKind: JobKind;
  /** The claimed job itself never counts as its own previous review. */
  excludeJobId: string;
};

export type JobsRepositoryOptions = {
  now?: () => Date;
  /** #397: see `db/supersede-timing.ts`. */
  supersededDrainMs?: number;
  newId?: () => string;
  /**
   * #195: resolves a job's review kind from the project's settings, inside the enqueue transaction so
   * it cannot race a settings change. Defaults to the stored project settings.
   */
  reviewKind?: ReviewKindResolver;
  /**
   * #195 rollout gate: whether Dynamic Review may be queued. Default: the instance setting, off.
   */
  dynamicReviewEnabled?: DynamicReviewGate;
  /**
   * #731: whether this deployment has the capability a review kind needs (src/capabilities/). A job of a kind it does not
   * have is refused with `JOB_KIND_UNAVAILABLE` before anything is written. Left out, every kind is allowed.
   */
  kindAllowed?: (kind: JobKind) => boolean;
};

export type JobsRepository = {
  /** Inserts a job unless the dedupe rules say one exists already; see the README of `src/jobs`. */
  enqueue(input: ValidEnqueueInput): Promise<EnqueueResult>;
  /**
   * #752: accepts a task of the Implementer: in one transaction the session, its first turn and the turn's job (a row of the
   * kind `implementer`, placeholders from `db/implementer-job-shape.ts`). Refuses with `JOB_KIND_UNAVAILABLE`, writing nothing,
   * when the deployment has no capability for the kind. Does not consult the Dynamic gate. A request id seen before gives the
   * turn it made, whatever else the request says. Rejects with `JOB_REPOSITORY_UNKNOWN`, or an `ImplementerStoreError`
   * (`IMPLEMENTER_BRANCH_TAKEN` and the others of the storage), writing nothing.
   */
  enqueueImplementerTurn(
    input: EnqueueImplementerTurnInput,
  ): Promise<EnqueueImplementerTurnResult>;
  /**
   * The turn a client request id made earlier (its job's delivery id is `implementer:<workspace id>:<client request id>`), or
   * undefined. Writes nothing and asks nothing of the platform: the service looks here first, so a retry minutes after the
   * agent pushed the branch gets the first task back and not "the branch exists". Not subject to `kindAllowed`: a deployment
   * without the capability has no such turn.
   */
  findImplementerTurn(
    clientRequestId: string,
  ): Promise<EnqueueImplementerTurnResult | undefined>;
  /** Cancels every waiting job of a repository (its project was deactivated); returns how many. */
  cancelWaitingForRepository(repositoryId: string): Promise<number>;
  /**
   * Cancels every waiting job of a repository because its project's review kind changed (#195):
   * they were queued for the other engine. Running jobs finish.
   */
  cancelWaitingForReviewKindChange(repositoryId: string): Promise<number>;
  /** Cancels the waiting jobs of one pull request (it was closed); returns how many. */
  discardWaitingForPr(repositoryId: string, prNumber: number): Promise<number>;
  discardWaitingAutomaticForPr(
    repositoryId: string,
    prNumber: number,
  ): Promise<number>;
  get(id: string): Promise<Job | undefined>;
  list(filter?: JobListFilter): Promise<Job[]>;
  /**
   * The exact head of the most recently successful review of this pull request for the same review
   * kind (#199), or null when there is none. A Dynamic job carries it as `previousReviewedSha`, so a
   * re-review compares against the head the earlier review actually saw; the claimed job itself is
   * never its own previous review.
   */
  previousReviewedSha(input: PreviousReviewedShaInput): Promise<string | null>;
  /**
   * The heads of this pull request's earlier jobs of the same review kind that ran and did not succeed
   * (#255), newest first and bounded, or an empty list, and whether the list was cut (#257). A run that wrote the summary and then did not
   * end `succeeded` (failed, or requeued and then superseded or cancelled) leaves its head in the
   * comment; the publisher accepts exactly these heads as a state it can account for. A job that never
   * ran (superseded or cancelled while waiting: `attempts = 0`, not `failed`) cannot have published and
   * never counts, so a burst of pushes cannot push a real head out of the bounded list. Only jobs
   * created strictly after the last successful review count (its state already includes everything
   * before it) and strictly before the claimed one (a newer job is a newer review, not a predecessor).
   * Ids are random, so jobs created in the same millisecond have no known order and are left out.
   */
  attemptedShas(input: PreviousReviewedShaInput): Promise<AttemptedShas>;
};

/**
 * The three columns that hold a fixed vocabulary, decoded; a stored value this version does not know
 * is a bug or a database from the future, and fails loudly. Also used by the read side
 * (`runs-repository.ts`).
 */
export function decodeJobVocabulary(
  row: Pick<JobsTable, "id" | "status" | "command" | "trigger_kind">,
) {
  if (!isJobStatus(row.status))
    throw new Error(
      `Stored job ${row.id} has the unknown status "${row.status}".`,
    );
  const command = STORED_REVIEW_COMMANDS.find((known) => known === row.command);
  if (command === undefined)
    throw new Error(
      `Stored job ${row.id} has the unknown command "${row.command}".`,
    );
  const triggerKind = JOB_TRIGGER_KINDS.find(
    (kind) => kind === row.trigger_kind,
  );
  if (triggerKind === undefined)
    throw new Error(
      `Stored job ${row.id} has the unknown trigger kind "${row.trigger_kind}".`,
    );
  return { status: row.status, command, triggerKind };
}

/** The stored kind of a job (#195, #752); a value this version does not know fails loudly. */
export function decodeReviewKind(row: {
  id: string;
  review_kind: string;
}): JobKind {
  const kind = JOB_KINDS.find((known) => known === row.review_kind);
  if (kind === undefined)
    throw new Error(
      `Stored job ${row.id} has the unknown review kind "${row.review_kind}".`,
    );
  return kind;
}

/** A stored row as the rest of the app sees it; also used by the read side (`runs-repository.ts`). */
export function toJob(row: Selectable<JobsTable>): Job {
  const { status, command, triggerKind } = decodeJobVocabulary(row);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    headSha: row.head_sha,
    reviewKind: decodeReviewKind(row),
    command,
    args: row.args,
    triggerKind,
    actorLogin: row.actor_login,
    deliveryId: row.delivery_id,
    status,
    runAfter: row.run_after,
    attempts: row.attempts,
    runnerId: row.runner_id,
    claimedAt: row.claimed_at,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    result: row.result === null ? null : decodeJson<JsonValue>(row.result),
    errorCode: row.error_code,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export function createJobsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  options: JobsRepositoryOptions = {},
): JobsRepository {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const supersededDrainMs = options.supersededDrainMs ?? SUPERSEDED_DRAIN_MS;
  // The jobs of one pull request and review kind in this workspace (#199, #255).
  const scopeOf = (input: PreviousReviewedShaInput) =>
    db
      .selectFrom("jobs")
      .where("workspace_id", "=", workspaceId)
      .where("repository_id", "=", input.repositoryId)
      .where("pr_number", "=", input.prNumber)
      .where("review_kind", "=", input.reviewKind);
  // The most recently finished successful review of that pull request and kind. A job that is still
  // running is not a previous review; the claimed job itself is excluded.
  const lastSucceeded = (input: PreviousReviewedShaInput) =>
    scopeOf(input)
      .select(["head_sha", "created_at"])
      .where("status", "=", "succeeded")
      .where("id", "!=", input.excludeJobId)
      .orderBy("finished_at", "desc")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
  const resolveReviewKind =
    options.reviewKind ?? createStoredReviewKindResolver(workspaceId, now);
  const dynamicReviewAllowed =
    options.dynamicReviewEnabled ?? createInstanceDynamicReviewGate();

  // The turn a repeated request made, by the delivery id of its job. Looked up before `createSessionWithTurn`: a job handed back
  // from its callback is refused there (`IMPLEMENTER_JOB_MISMATCH`) and rolled back, so a repeat must never get that far; and
  // by the service before it asks the platform anything.
  async function findImplementerTurn(
    clientRequestId: string,
  ): Promise<EnqueueImplementerTurnResult | undefined> {
    const row = await db
      .selectFrom("jobs")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where(
        "delivery_id",
        "=",
        implementerDeliveryId(workspaceId, clientRequestId),
      )
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const found = await createImplementerRepository(
      db,
      workspaceId,
      now,
      newId,
    ).getTurnByJob(row.id);
    // A job with this delivery id that is no turn cannot be: the id has the prefix only turns write. Not an answer.
    if (found === undefined) return undefined;
    return { status: "existing", job: toJob(row), ...found };
  }

  // A transaction cannot start another one; inside one, just use it.
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    const guarded = async (trx: Kysely<Database>) => {
      await lockDynamicReviewGate(trx, false);
      return run(trx);
    };
    return db.isTransaction ? guarded(db) : db.transaction().execute(guarded);
  }

  async function cancelWaiting(
    where: {
      repositoryId: string;
      prNumber?: number;
      /** Only jobs a webhook created (`trigger_kind = webhook`), not the ones a person started. */
      automaticOnly?: boolean;
    },
    errorCode: JobErrorCode,
  ): Promise<number> {
    return inTransaction(async (trx) => {
      const timestamp = formatTimestamp(now());
      let query = trx
        .updateTable("jobs")
        .set({
          status: "cancelled",
          error_code: errorCode,
          finished_at: timestamp,
          updated_at: timestamp,
        })
        .where("workspace_id", "=", workspaceId)
        .where("status", "in", statusesThatCanBecome("cancelled"))
        .where("repository_id", "=", where.repositoryId)
        // #752: nothing that acts on pull requests (a closed one, a draft, a deactivated project, a changed review kind) touches a
        // turn of the Implementer, whatever its placeholder number is.
        .where("review_kind", "<>", "implementer");
      if (where.prNumber !== undefined)
        query = query.where("pr_number", "=", where.prNumber);
      if (where.automaticOnly === true)
        query = query.where("trigger_kind", "=", "webhook");
      await lockJobRowsInOrder(
        trx,
        trx
          .selectFrom("jobs")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("repository_id", "=", where.repositoryId)
          .where("review_kind", "<>", "implementer")
          .where("status", "=", "queued"),
      );
      const result = await query.executeTakeFirst();
      // A job that waited again after a lost lease keeps a reserved usage record; it no longer counts.
      const voided = await createUsageRecordsRepository(
        trx,
        workspaceId,
        now,
      ).voidEndedJobsWithIds();
      // #498: a job that took a hold before it waited again gives it back.
      await settleEndedJobs(trx, voided, now);
      return Number(result.numUpdatedRows);
    });
  }

  return {
    enqueue(input) {
      return inTransaction<EnqueueResult>(async (trx) => {
        const current = now();
        const timestamp = formatTimestamp(current);

        // Settings saves lock this same workspace-scoped row, including before a project exists.
        const repository = trx
          .selectFrom("repositories")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", input.repositoryId);
        await (
          databaseDriver(trx) === "postgres"
            ? repository.forUpdate()
            : repository
        ).executeTakeFirst();

        await lockJobRowsInOrder(
          trx,
          trx
            .selectFrom("jobs")
            .select("id")
            .where("workspace_id", "=", workspaceId)
            .where("repository_id", "=", input.repositoryId)
            .where("status", "in", ["queued", "running"]),
        );

        // #195 (finding 3): resolve the kind here, in the same transaction as the insert, so a
        // concurrent settings change cannot slip between the read and the write. A kind named by the
        // caller (tests, a re-queue) wins.
        const reviewKind =
          input.reviewKind ??
          (await resolveReviewKind(trx, input.repositoryId));
        // #731: a kind this deployment has no capability for is never queued (the transaction ends, nothing is written).
        if (options.kindAllowed?.(reviewKind) === false)
          throw new JobQueueError(
            "JOB_KIND_UNAVAILABLE",
            `This deployment has no capability for review kind ${reviewKind}.`,
          );
        // #195 rollout gate: with Dynamic Review off, the job is created failed instead of queued, so
        // a previous-release app can never claim a Dynamic row as Diff and no run is silently a Diff
        // review.
        const dynamicDisabled =
          reviewKind === "dynamic" && !(await dynamicReviewAllowed(trx));

        // 1. The same delivery again (GitHub's "Redeliver", or a request that ran twice).
        if (input.deliveryId !== null) {
          const sameDelivery = await trx
            .selectFrom("jobs")
            .selectAll()
            .where("workspace_id", "=", workspaceId)
            .where("delivery_id", "=", input.deliveryId)
            .executeTakeFirst();
          if (sameDelivery !== undefined)
            return {
              status: "existing",
              job: toJob(sameDelivery),
              reason: "same_delivery",
            };
        }

        // 1b. The same comment again, under another delivery id (a replayed signed body, or two
        // deliveries of one comment): one answer per comment, whatever became of its job.
        if (input.commentId !== null) {
          const sameComment = await trx
            .selectFrom("job_comments")
            .innerJoin("jobs", "jobs.id", "job_comments.job_id")
            .selectAll("jobs")
            .where("jobs.workspace_id", "=", workspaceId)
            .where("job_comments.repository_id", "=", input.repositoryId)
            .where("job_comments.comment_id", "=", input.commentId)
            .executeTakeFirst();
          if (sameComment !== undefined)
            return {
              status: "existing",
              job: toJob(sameComment),
              reason: "same_comment",
            };
        }

        // The comment is answered by the job that comes out of the steps below, a new one or an
        // equal one that exists already; either way the comment is recorded, so its replay finds it.
        const recordComment = async (jobId: string) => {
          if (input.commentId === null) return;
          await trx
            .insertInto("job_comments")
            .values({
              repository_id: input.repositoryId,
              comment_id: input.commentId,
              job_id: jobId,
            })
            .execute();
        };

        const samePullRequest = () =>
          trx
            .selectFrom("jobs")
            .selectAll()
            .where("workspace_id", "=", workspaceId)
            .where("repository_id", "=", input.repositoryId)
            .where("pr_number", "=", input.prNumber)
            .where("command", "=", input.command)
            // #195: a Diff job and a Dynamic job are different jobs. Dedupe and supersession must
            // never treat one kind's job as a duplicate of the other's.
            .where("review_kind", "=", reviewKind);

        if (input.triggerKind === "webhook") {
          // 2. One automatic job per head commit and command, whatever became of it, unless it was
          // replaced or cancelled (then the slot is free again).
          const sameHead = await samePullRequest()
            .where("head_sha", "=", input.headSha)
            .where("trigger_kind", "=", "webhook")
            .where("status", "in", [...SLOT_HOLDING_STATUSES])
            .executeTakeFirst();
          if (sameHead !== undefined) {
            await recordComment(sameHead.id);
            return {
              status: "existing",
              job: toJob(sameHead),
              reason: "same_head",
            };
          }
        } else {
          // 2. A job started by a person never duplicates one that is still waiting or running.
          const active = await samePullRequest()
            .where("args", "=", input.args)
            .where("status", "in", ["queued", "running"])
            .orderBy("created_at")
            .orderBy("id")
            .executeTakeFirst();
          if (active !== undefined) {
            await recordComment(active.id);
            // A person does not wait: a waiting job that was held back (a job given back with a retry time
            // job after `synchronize`) is due now.
            const pulledForward =
              active.status === "queued" &&
              active.run_after > timestamp &&
              (await trx
                .updateTable("jobs")
                .set({ run_after: timestamp, updated_at: timestamp })
                .where("id", "=", active.id)
                .where("status", "=", "queued")
                .returningAll()
                .executeTakeFirst());
            return {
              status: "existing",
              job: toJob(pulledForward || active),
              reason: "already_active",
            };
          }
        }

        // 3. The new job. With Dynamic Review gated off, it is created already failed so the run is
        // visible (Runs) and no runner is ever handed a Dynamic row.
        const id = newId();
        const inserted = await trx
          .insertInto("jobs")
          .values({
            id,
            workspace_id: workspaceId,
            repository_id: input.repositoryId,
            pr_number: input.prNumber,
            pr_url: input.prUrl,
            head_sha: input.headSha,
            command: input.command,
            review_kind: reviewKind,
            args: input.args,
            trigger_kind: input.triggerKind,
            actor_login: input.actorLogin,
            delivery_id: input.deliveryId,
            status: dynamicDisabled ? "failed" : "queued",
            run_after: formatTimestamp(input.runAfter ?? current),
            attempts: 0,
            runner_id: null,
            lease_token: null,
            claimed_at: null,
            heartbeat_at: null,
            lease_expires_at: null,
            result: null,
            error_code: dynamicDisabled ? "dynamic_review_disabled" : null,
            superseded_by: null,
            created_at: timestamp,
            updated_at: timestamp,
            finished_at: dynamicDisabled ? timestamp : null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await recordComment(id);

        // 4. An automatic job replaces the automatic jobs of the same pull request, command and arguments
        // that would review an older state. Jobs a person asked for are never replaced.
        //  - A waiting one is dropped: it never ran, its reserved record no longer counts.
        //  - A running one is superseded (#397) only when its holder understands it
        //    (`accepts_supersede`, the feature `supersede` of #396): it keeps its claim for the drain window, is
        //    told by its next heartbeat, finishes the model requests in flight and reports what it used. One of an
        //    earlier release is left alone, and the new job waits behind it as before.
        let supersededJobIds: string[] = [];
        if (input.triggerKind === "webhook") {
          const older = () =>
            samePullRequest()
              .select("id")
              .where("args", "=", input.args)
              .where("trigger_kind", "=", "webhook")
              .where("id", "!=", id);
          const waiting = await older()
            .where("status", "=", "queued")
            .execute();
          const running = await older()
            .where("status", "=", "running")
            .where("accepts_supersede", "=", 1)
            .execute();
          const records = createUsageRecordsRepository(trx, workspaceId, now);
          // The ids come from the rows the updates changed, not from the selects: the list stays honest whatever
          // the locking does.
          const droppedIds: string[] = [];
          const drainingIds: string[] = [];
          if (waiting.length > 0) {
            const changed = await trx
              .updateTable("jobs")
              .set({
                status: "superseded",
                superseded_by: id,
                finished_at: timestamp,
                updated_at: timestamp,
              })
              .where(
                "id",
                "in",
                waiting.map((row) => row.id),
              )
              .where("status", "=", "queued")
              .returning("id")
              .execute();
            droppedIds.push(...changed.map((row) => row.id));
          }
          if (running.length > 0) {
            const changed = await trx
              .updateTable("jobs")
              .set({
                status: "superseded",
                superseded_by: id,
                finished_at: timestamp,
                lease_expires_at: formatTimestamp(
                  new Date(current.getTime() + supersededDrainMs),
                ),
                updated_at: timestamp,
              })
              .where(
                "id",
                "in",
                running.map((row) => row.id),
              )
              .where("status", "=", "running")
              .returning("id")
              .execute();
            drainingIds.push(...changed.map((row) => row.id));
            // Its record stays reserved until the Worker reports (or the drain ends), but it is marked: a
            // superseded run is not a run of the quota (src/usage/README.md).
            await records.markSuperseded(drainingIds);
          }
          supersededJobIds = [...droppedIds, ...drainingIds];
          // Only when jobs were replaced: the reserved records of the waiting ones no longer count.
          if (droppedIds.length > 0)
            await settleEndedJobs(
              trx,
              await records.voidEndedJobsWithIds(),
              now,
            );
        }

        return { status: "created", job: toJob(inserted), supersededJobIds };
      });
    },

    findImplementerTurn: (clientRequestId) =>
      findImplementerTurn(clientRequestId),

    async enqueueImplementerTurn(input) {
      // Before anything is read or written: a deployment without the capability never has a turn, not even an answer to a repeat.
      if (options.kindAllowed?.("implementer") === false)
        throw new JobQueueError(
          "JOB_KIND_UNAVAILABLE",
          "This deployment has no capability for review kind implementer.",
        );
      const repeated = await findImplementerTurn(input.clientRequestId);
      if (repeated !== undefined) return repeated;

      const task: NewImplementerTask = {
        repositoryId: input.repositoryId,
        baseBranch: input.baseBranch,
        branch: input.branch,
        instruction: input.instruction,
        modelChoice: input.modelChoice,
        costLimitCents: input.costLimitCents,
        createdBy: input.createdBy,
      };
      try {
        return await inTransaction<EnqueueImplementerTurnResult>(
          async (trx) => {
            const timestamp = formatTimestamp(now());
            const created = await createImplementerRepository(
              trx,
              workspaceId,
              now,
              newId,
            ).createSessionWithTurn(task, async (inner, { slot }) => {
              const repository = await inner
                .selectFrom("repositories")
                .select("url")
                .where("workspace_id", "=", workspaceId)
                .where("id", "=", input.repositoryId)
                .executeTakeFirstOrThrow();
              const shape = implementerJobShape({
                workspaceId,
                repositoryUrl: repository.url,
                branch: input.branch,
                slot,
                baseSha: input.baseSha,
                clientRequestId: input.clientRequestId,
              });
              const id = newId();
              await inner
                .insertInto("jobs")
                .values({
                  id,
                  workspace_id: workspaceId,
                  repository_id: input.repositoryId,
                  pr_number: shape.prNumber,
                  pr_url: shape.prUrl,
                  head_sha: shape.headSha,
                  command: shape.command,
                  review_kind: "implementer",
                  args: shape.args,
                  trigger_kind: "manual",
                  actor_login: input.actorLogin,
                  delivery_id: shape.deliveryId,
                  status: "queued",
                  run_after: timestamp,
                  attempts: 0,
                  runner_id: null,
                  lease_token: null,
                  claimed_at: null,
                  heartbeat_at: null,
                  lease_expires_at: null,
                  result: null,
                  error_code: null,
                  superseded_by: null,
                  created_at: timestamp,
                  updated_at: timestamp,
                  finished_at: null,
                })
                .execute();
              return id;
            });
            const job = await trx
              .selectFrom("jobs")
              .selectAll()
              .where("id", "=", created.turn.jobId)
              .executeTakeFirstOrThrow();
            return { status: "created", job: toJob(job), ...created };
          },
        );
      } catch (error) {
        if (
          error instanceof ImplementerStoreError &&
          error.code === "IMPLEMENTER_REPOSITORY_NOT_FOUND"
        )
          throw new JobQueueError(
            "JOB_REPOSITORY_UNKNOWN",
            `No repository row ${input.repositoryId}.`,
            { cause: error },
          );
        // Two requests with one id raced past the lookup: the one that lost finds the turn the other made (its branch is taken, or
        // the unique index of the delivery id refuses the job). Anything else, or no such turn, is the caller's.
        if (
          (error instanceof ImplementerStoreError &&
            error.code === "IMPLEMENTER_BRANCH_TAKEN") ||
          errorCode(error) === UNIQUE_VIOLATION
        ) {
          const raced = await findImplementerTurn(input.clientRequestId);
          if (raced !== undefined) return raced;
        }
        throw error;
      }
    },

    cancelWaitingForRepository(repositoryId) {
      return cancelWaiting({ repositoryId }, "project_deactivated");
    },

    // #195: the project's review kind changed (Diff <-> Dynamic), so every waiting job of the
    // repository was queued for the wrong engine. The settings change and this cancellation run in
    // one transaction (the #194 hook), so a failed save keeps the kind and the jobs. A running job
    // finishes.
    cancelWaitingForReviewKindChange(repositoryId) {
      return cancelWaiting({ repositoryId }, "review_kind_changed");
    },

    discardWaitingForPr(repositoryId, prNumber) {
      return cancelWaiting({ repositoryId, prNumber }, "pull_request_closed");
    },

    discardWaitingAutomaticForPr(repositoryId, prNumber) {
      return cancelWaiting(
        { repositoryId, prNumber, automaticOnly: true },
        "pull_request_draft",
      );
    },

    async get(id) {
      const row = await db
        .selectFrom("jobs")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toJob(row);
    },

    async list(filter = {}) {
      let query = db
        .selectFrom("jobs")
        .selectAll()
        .where("workspace_id", "=", workspaceId);
      if (filter.repositoryId !== undefined)
        query = query.where("repository_id", "=", filter.repositoryId);
      if (filter.prNumber !== undefined)
        query = query.where("pr_number", "=", filter.prNumber);
      if (filter.status !== undefined)
        query = query.where(
          "status",
          "in",
          Array.isArray(filter.status) ? filter.status : [filter.status],
        );
      const limit = Math.min(
        Math.max(1, Math.trunc(filter.limit ?? JOB_LIST_DEFAULT_LIMIT)),
        JOB_LIST_MAX_LIMIT,
      );
      const rows = await query
        .orderBy("created_at")
        .orderBy("id")
        .limit(limit)
        .execute();
      return rows.map(toJob);
    },

    async previousReviewedSha(input) {
      // #752: a turn has no reviewed head: its `head_sha` is the base branch tip read when the task was accepted.
      if (input.reviewKind === "implementer") return null;
      return (await lastSucceeded(input))?.head_sha ?? null;
    },

    async attemptedShas(input) {
      if (input.reviewKind === "implementer")
        return { shas: [], truncated: false };
      const claimed = await scopeOf(input)
        .select("created_at")
        .where("id", "=", input.excludeJobId)
        .executeTakeFirst();
      if (claimed === undefined) return { shas: [], truncated: false };
      const last = await lastSucceeded(input);
      let query = scopeOf(input)
        .select("head_sha")
        .where("status", "!=", "succeeded")
        // Only a job that ran can have published: failed, a lost attempt (requeue, released claim), or a run
        // that was superseded while it ran (#397: it may have written its summary just before it heard of it).
        .where((eb) =>
          eb.or([
            eb("status", "=", "failed"),
            eb("attempts", ">", 0),
            eb.and([
              eb("status", "=", "superseded"),
              eb("claimed_at", "is not", null),
            ]),
          ]),
        )
        .where("id", "!=", input.excludeJobId)
        .where("created_at", "<", claimed.created_at);
      if (last !== undefined)
        query = query.where("created_at", ">", last.created_at);
      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        // One row more than the scan: a full scan cannot tell whether an older head is left out.
        .limit(ATTEMPTED_SCAN_LIMIT + 1)
        .execute();
      const distinct = [...new Set(rows.map((row) => row.head_sha))];
      return {
        shas: distinct.slice(0, MAX_ATTEMPTED_SHAS),
        truncated:
          rows.length > ATTEMPTED_SCAN_LIMIT ||
          distinct.length > MAX_ATTEMPTED_SHAS,
      };
    },
  };
}
