// SPDX-License-Identifier: LicenseRef-Proprietary

// Fixtures for the job queue tests: a migrated database with one integration and a few repositories,
// a clock the test moves by hand, and a way to enqueue with sensible defaults.
import type { Kysely } from "kysely";
import { formatTimestamp } from "../db/codecs.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { toJob } from "../db/repositories/jobs-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { Database } from "../db/schema.ts";
import { createJobQueue, type JobQueue } from "../jobs/job-queue.ts";
import { createRunnerQueue, type RunnerQueue } from "../jobs/runner-queue.ts";
import type { RunnerJobsRepositoryOptions } from "../db/repositories/runner-jobs-repository.ts";
import {
  dynamicReviewEnabled as allowDynamicReview,
  type DynamicReviewGate,
} from "../jobs/dynamic-review-gate.ts";
import type { ReviewKindResolver } from "../jobs/review-kind.ts";
import type {
  EnqueueJobInput,
  Job,
  JobTriggerKind,
} from "../jobs/job-types.ts";
import type { JobStatus } from "../db/job-status.ts";
import type { JobQueueLimits } from "../db/job-limits.ts";
import type { ProjectReviewKind } from "../job-kind/job-kind.ts";
import { createTestDatabase } from "./test-database.ts";
import { defaultWorkspaceId } from "./workspaces.ts";

export const T0 = new Date("2026-10-10T12:00:00.000Z");

export function sha(letter: string): string {
  return letter.repeat(40);
}

export type TestClock = {
  now(): Date;
  set(date: Date): void;
  advance(ms: number): void;
};

export function createTestClock(start: Date = T0): TestClock {
  let current = start;
  return {
    now: () => current,
    set(date) {
      current = date;
    },
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

/**
 * The queue of one workspace together with the runner side of the queue, for tests that enqueue and
 * claim through one object. In the app these are two objects: the runner side is not scoped.
 */
export type TestQueue = JobQueue & RunnerQueue;

export function createTestQueue(
  db: Kysely<Database>,
  workspaceId: string,
  options: {
    now?: () => Date;
    limits?: Partial<JobQueueLimits>;
    /** #195 rollout gate; default: the instance setting (off). */
    dynamicReviewEnabled?: DynamicReviewGate;
    /** #195: override the in-transaction kind resolver (tests). */
    reviewKind?: ReviewKindResolver;
    /** #277: called for every job the claim refused, after the claim committed. */
    onRefused?: RunnerJobsRepositoryOptions["onRefused"];
    /** #361: called for every record that settled without a known cost, after the transaction committed. */
    onUnknownCostSettled?: RunnerJobsRepositoryOptions["onUnknownCostSettled"];
    /** #487: called with the jobs whose running claim a call ended, after the transaction committed. */
    onClaimsEnded?: RunnerJobsRepositoryOptions["onClaimsEnded"];
    /** #972: called with the jobs a lapsed lease put back in the queue, after the transaction committed. */
    onRequeued?: RunnerJobsRepositoryOptions["onRequeued"];
  } = {},
): TestQueue {
  return {
    ...createJobQueue(db, workspaceId, options),
    ...createRunnerQueue(db, options),
  };
}

export type JobQueueFixture = {
  db: Kysely<Database>;
  workspaceId: string;
  /**
   * The URL of the Postgres database, for a second connection or a child process. A fixture on a
   * supplied connection does not know it: reading this throws instead of handing out an empty URL.
   */
  databaseUrl: string;
  queue: TestQueue;
  clock: TestClock;
  /** The first repository (it gets all jobs of `enqueue` unless told otherwise). */
  repositoryId: string;
  otherRepositoryId: string;
  /** Enqueues an automatic review job on PR 7 for `sha("a")`, with any field overridden. */
  enqueue(
    overrides?: Partial<EnqueueJobInput>,
  ): ReturnType<JobQueue["enqueue"]>;
  /** The lease token stored for a job right now (what its current holder presents). */
  tokenOf(jobId: string): Promise<string>;
  /** Enqueues, expects a new job, and returns it. */
  enqueueNew(overrides?: Partial<EnqueueJobInput>): Promise<Job>;
  /**
   * Inserts a job row directly, for history tests only (#203): the queue cannot create a removed
   * command any more, but a database from before the upgrade still holds such rows.
   */
  seedHistoricalJob(overrides: {
    command: "review" | "improve" | "describe" | "ask";
    repositoryId?: string;
    prNumber?: number;
    /** Defaults to a finished, succeeded review. */
    status?: JobStatus;
    triggerKind?: JobTriggerKind;
    args?: string;
    result?: unknown;
    errorCode?: string | null;
    actorLogin?: string;
    /** #199: the head the historical review saw; defaults to `sha("a")`. */
    headSha?: string;
    /** #199: the review kind of the historical review; defaults to the column default (diff). */
    reviewKind?: ProjectReviewKind;
    /** #255: the lost attempts of the row; defaults to 0 (a job that never ran). */
    attempts?: number;
    /** For a `running` row: the claim token; defaults to a fixed one, and the lease is live. */
    leaseToken?: string;
    /** For a `running` row: an ISO timestamp; defaults to the fixture's now. */
    leaseExpiresAt?: string;
  }): Promise<Job>;
};

export async function createJobQueueFixture(
  options: {
    limits?: Partial<JobQueueLimits>;
    /** A database to seed instead of a fresh one (a pool of another size, for example). */
    database?: Kysely<Database>;
    /** #195: enable the Dynamic Review rollout gate for this fixture (default off). */
    dynamicReview?: boolean;
    /** #277: called for every job the claim of the queue refused, after the claim committed. */
    onRefused?: RunnerJobsRepositoryOptions["onRefused"];
    /** #361: called for every record that settled without a known cost, after the transaction committed. */
    onUnknownCostSettled?: RunnerJobsRepositoryOptions["onUnknownCostSettled"];
    /** #487: called with the jobs whose running claim a call ended, after the transaction committed. */
    onClaimsEnded?: RunnerJobsRepositoryOptions["onClaimsEnded"];
    /** #972: called with the jobs a lapsed lease put back in the queue, after the transaction committed. */
    onRequeued?: RunnerJobsRepositoryOptions["onRequeued"];
  } = {},
): Promise<JobQueueFixture> {
  const created = options.database
    ? { db: options.database, databaseUrl: null as string | null }
    : await (async () => {
        const test = await createTestDatabase();
        return { db: test.db, databaseUrl: test.url as string | null };
      })();
  const { db } = created;
  const clock = createTestClock();
  // Both enqueue and lease-loss policy read the stored instance gate.
  if (options.dynamicReview === true)
    await createInstanceSettingsRepository(db, clock.now).set(
      "dynamic_review",
      { enabled: true },
      null,
    );
  const workspaceId = await defaultWorkspaceId(db);
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
    clock.now,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(db, workspaceId, clock.now);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "7001",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
    {
      integrationId: integration.id,
      externalId: "7002",
      fullName: "acme/gadgets",
      url: "https://github.test/acme/gadgets",
    },
  ]);
  const [first, second] = await repositories.list({
    integrationId: integration.id,
  });
  if (first === undefined || second === undefined)
    throw new Error("The fixture repositories were not created.");

  const queue = createTestQueue(db, workspaceId, {
    now: clock.now,
    limits: options.limits,
    ...(options.onRefused === undefined
      ? {}
      : { onRefused: options.onRefused }),
    ...(options.onUnknownCostSettled === undefined
      ? {}
      : { onUnknownCostSettled: options.onUnknownCostSettled }),
    ...(options.onClaimsEnded === undefined
      ? {}
      : { onClaimsEnded: options.onClaimsEnded }),
    ...(options.onRequeued === undefined
      ? {}
      : { onRequeued: options.onRequeued }),
    dynamicReviewEnabled:
      options.dynamicReview === true ? allowDynamicReview : undefined,
  });
  const defaults = (overrides: Partial<EnqueueJobInput>): EnqueueJobInput => ({
    repositoryId: first.id,
    prNumber: 7,
    prUrl: "https://github.test/acme/widgets/pull/7",
    headSha: sha("a"),
    command: "review",
    triggerKind: "webhook",
    actorLogin: "octocat",
    ...overrides,
  });
  return {
    db,
    workspaceId,
    get databaseUrl(): string {
      if (created.databaseUrl === null)
        throw new Error(
          "A job queue fixture on a supplied connection has no database URL; use its connection.",
        );
      return created.databaseUrl;
    },
    queue,
    clock,
    repositoryId: first.id,
    otherRepositoryId: second.id,
    enqueue: (overrides = {}) => queue.enqueue(defaults(overrides)),
    async tokenOf(jobId) {
      const row = await db
        .selectFrom("jobs")
        .select("lease_token")
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow();
      if (row.lease_token === null)
        throw new Error(`Job ${jobId} has no lease token.`);
      return row.lease_token;
    },
    async enqueueNew(overrides = {}) {
      const result = await queue.enqueue(defaults(overrides));
      if (result.status !== "created")
        throw new Error(`Expected a new job, got: ${result.reason}`);
      return result.job;
    },
    async seedHistoricalJob(overrides) {
      const status = overrides.status ?? "succeeded";
      const timestamp = formatTimestamp(clock.now());
      const id = crypto.randomUUID();
      const running = status === "running";
      await db
        .insertInto("jobs")
        .values({
          id,
          workspace_id: workspaceId,
          repository_id: overrides.repositoryId ?? first.id,
          pr_number: overrides.prNumber ?? 7,
          pr_url: "https://github.test/acme/widgets/pull/7",
          head_sha: overrides.headSha ?? sha("a"),
          command: overrides.command,
          args: overrides.args ?? "",
          trigger_kind: overrides.triggerKind ?? "comment",
          ...(overrides.reviewKind === undefined
            ? {}
            : { review_kind: overrides.reviewKind }),
          actor_login: overrides.actorLogin ?? "octocat",
          delivery_id: null,
          status,
          run_after: timestamp,
          attempts: overrides.attempts ?? 0,
          runner_id: running ? "runner-1" : null,
          lease_token: running
            ? (overrides.leaseToken ?? "historical-lease")
            : null,
          claimed_at: running ? timestamp : null,
          heartbeat_at: running ? timestamp : null,
          lease_expires_at: running
            ? (overrides.leaseExpiresAt ?? timestamp)
            : null,
          result:
            overrides.result === undefined
              ? null
              : JSON.stringify(overrides.result),
          error_code: overrides.errorCode ?? null,
          superseded_by: null,
          created_at: timestamp,
          updated_at: timestamp,
          finished_at:
            status === "queued" || status === "running" ? null : timestamp,
        })
        .execute();
      const row = await db
        .selectFrom("jobs")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return toJob(row);
    },
  };
}
