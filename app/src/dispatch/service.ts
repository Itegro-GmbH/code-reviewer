// SPDX-License-Identifier: LicenseRef-Proprietary

// The dispatch webhook as a service (#326): wakes the Dispatcher for a job that was queued, and keeps the
// state of that call in `job_dispatches` so a call that failed is made again.
//
// - `onEnqueued(result)` is the hook of `createJobQueue`: it runs after the enqueue transaction committed
//   (in `after()` in the app, src/dispatch/shared.ts), never throws and never delays the enqueue.
// - `sendDue(limit)` is the hook of the cron sweep (#328): it sends every queued job that is due and has no
//   call yet, or whose call is due again (back-off over, acknowledgement timeout over, a job given back).
//   Nothing here schedules itself: no timer, no loop. A serverless instance lives for seconds.
// - `sendWaiting(...)` and `redispatch(jobId)` (#395) are what runs when a job ends: the jobs that were told "not
//   now" (the pool cap, the running job of their pull request) are sent as soon as a slot frees, and a job that was
//   given back after a failed launch is sent again at once. The normal flow never waits for the sweep.
//
// A send is claimed in the row first (`claimSend`, a compare and set on `next_dispatch_at`), so the request
// that queued the job, the sweep and another instance never send the same call twice. The job itself is
// durable before any of this starts: nothing here can lose it.
import "server-only";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { errorCode } from "../db/errors.ts";
import {
  createJobDispatchesRepository,
  type DispatchRow,
  type DueDispatchJob,
  type PullRequestRef,
} from "../db/repositories/job-dispatches-repository.ts";
import type { Database } from "../db/schema.ts";
import type { EnqueueResult } from "../jobs/job-types.ts";
import type { WebhookDispatchConfig } from "./config.ts";
import {
  decideOutcome,
  type DispatchResultCode,
  type DispatchUpdate,
} from "./outcome.ts";
import { buildDispatchRequest } from "./request.ts";
import {
  DISPATCH_TIMEOUT_MS,
  sendDispatch,
  type DispatchFetch,
} from "./send.ts";

/** How long a claimed send holds the row: the request limit plus time to store the answer. */
export const SEND_LEASE_MS = 30_000;
/** How many jobs one `sendDue` sends if not told otherwise, and how many requests it has in flight. */
export const DEFAULT_SEND_LIMIT = 20;
const SEND_CONCURRENCY = 5;
/**
 * #395: a call that failed with a transient answer is made again inside the request that queued the job, after
 * these pauses (at most three more calls), so a hiccup of the Dispatcher does not wait for the sweep.
 */
export const INLINE_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 8_000];
/**
 * The longest a request spends on inline retries, pauses and calls together (the function lives 60 seconds; the
 * request that queued the job needs a few of them before this starts). A retry is started only when its pause and its
 * longest possible call still fit, so the budget is a bound, not a target (#479: it was 35 seconds, too little for the
 * 20 or 30 seconds a not-ready or busy Dispatcher asks for).
 */
export const INLINE_RETRY_BUDGET_MS = 45_000;
/**
 * A `Retry-After` longer than this is not waited for inline; the row keeps it, and a slot that frees, a request that
 * touches the database or the sweep sends the job (`WAITING_DISPATCH_CODES`). 30 seconds covers the `Retry-After` of a
 * busy Dispatcher (30) and of a Dispatcher that is not ready (20), the two it gives while it is launching (#479).
 */
export const INLINE_RETRY_MAX_WAIT_MS = 30_000;
/**
 * How long a job that was given back may wait for its retry time inside the request that gave it back: the
 * Dispatcher gives a job back with 30 seconds, so that it does not start again in a hot loop (#395).
 */
export const REDISPATCH_MAX_WAIT_MS = 35_000;
/** Added to the wait for a retry time: a timer can fire a little before the clock of the database says it is time. */
export const REDISPATCH_SLACK_MS = 250;
/** The answers worth another try at once. A refusal (`rejected`) needs an operator and is never repeated inline. */
const TRANSIENT_CODES: readonly DispatchResultCode[] = [
  "rate_limited",
  "unavailable",
  "server_error",
  "timeout",
  "network_error",
];

export type DispatchLog = {
  /** A send that failed and will be made again. */
  warn(line: string): void;
  /** An answer an operator has to look at, or a dispatch that could not even be recorded. */
  error(line: string): void;
};

export type DispatchService = {
  /**
   * The hook of the job queue. Never rejects. `receivedAt` (#479) is when the request that enqueued the job began its
   * hook, on the monotonic clock of the service: the budget of the inline retries is counted from it, so the work the
   * request did before `after()` ran is part of it. Without it the budget starts with the first call.
   */
  onEnqueued(
    result: EnqueueResult,
    context?: { receivedAt?: number },
  ): Promise<void>;
  /**
   * The hook of the sweep: sends what is due. Never rejects. With `minAgeMs` (#395) a job that changed less than that
   * long ago is left to the request that queued it (the repair work of the other requests asks for it).
   */
  sendDue(
    limit?: number,
    options?: { minAgeMs?: number },
  ): Promise<{ sent: number }>;
  /**
   * One job of `listDue`, as `sendDue` sends it. False when it sent nothing: another sender holds the job or
   * already dealt with it since the listing was made. Never rejects.
   */
  sendJob(job: DueDispatchJob): Promise<boolean>;
  /**
   * #395: a slot freed (a job ended). Asks the queued jobs that were told "not now" (the pool cap, the running job of
   * their pull request), the job of `first` before the others, whatever time their row says, until `limit` wake-ups
   * were **accepted** or the candidates (at most 20) are used up: a job that is refused again does not use the slot.
   * No send is started after `deadline` (a time of the monotonic clock of the service). Returns how many wake-ups
   * were accepted. Never rejects.
   */
  sendWaiting(options: {
    limit: number;
    first?: PullRequestRef;
    deadline?: number;
  }): Promise<{ sent: number }>;
  /**
   * #395: a job was given back to the queue after a launch that failed: its dispatch is due again and is sent when
   * its retry time has passed, waited for inside the request if that fits before `deadline`; else the next sender
   * (a later request, the sweep) sends it. Never rejects.
   */
  redispatch(jobId: string, options?: { deadline?: number }): Promise<void>;
};

type JobToSend = DueDispatchJob;

export function createDispatchService(options: {
  db: Kysely<Database>;
  config: WebhookDispatchConfig;
  fetch?: DispatchFetch;
  now?: () => Date;
  newId?: () => string;
  timeoutMs?: number;
  log?: DispatchLog;
  /** The pauses of the inline retries (#395); `[]` makes none. Default: `INLINE_RETRY_DELAYS_MS`. */
  inlineRetryDelaysMs?: readonly number[];
  /** Waits (default: a timer); tests pass a fake that moves their clock. */
  sleep?: (ms: number) => Promise<void>;
  /** A monotonic clock in milliseconds, for the budget of the inline retries. */
  monotonicMs?: () => number;
}): DispatchService {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DISPATCH_TIMEOUT_MS;
  const retryDelays = options.inlineRetryDelaysMs ?? INLINE_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const monotonicMs = options.monotonicMs ?? (() => performance.now());
  const log: DispatchLog = options.log ?? {
    warn: (line) => console.warn(line),
    error: (line) => console.error(line),
  };
  const { config } = options;
  const dispatches = createJobDispatchesRepository(options.db, now);

  /** Logs a failed send: the stable code and the numbers, nothing the answer or the error said. */
  function report(job: JobToSend, update: DispatchUpdate): void {
    if (update.lastCode === "accepted" || update.state === "stopped") return;
    const status =
      update.lastStatus === null ? "none" : String(update.lastStatus);
    if (update.alert) {
      log.error(
        `[dispatch] DISPATCH_REJECTED job=${job.jobId} code=${update.lastCode} status=${status} retry_at=${update.nextDispatchAt.toISOString()}: check RUNNER_WEBHOOK_URL and RUNNER_WEBHOOK_SECRET against the Dispatcher`,
      );
      return;
    }
    if (update.consecutiveFailures === 0) return;
    log.warn(
      `[dispatch] DISPATCH_SEND_FAILED job=${job.jobId} code=${update.lastCode} status=${status} failures=${String(update.consecutiveFailures)} retry_at=${update.nextDispatchAt.toISOString()}`,
    );
  }

  /** Claims the send and makes it. False when another sender holds the job; else what the answer came to. */
  async function claimAndSend(
    job: JobToSend,
    row: DispatchRow,
  ): Promise<DispatchUpdate | false> {
    const claimed = await dispatches.claimSend(
      job.jobId,
      row.nextDispatchAt,
      new Date(now().getTime() + SEND_LEASE_MS),
    );
    if (!claimed) return false;

    const sentAt = now();
    const request = buildDispatchRequest({
      key: config.currentKey,
      ...(config.bypassToken === undefined
        ? {}
        : { bypassToken: config.bypassToken }),
      jobId: job.jobId,
      reviewKind: job.reviewKind,
      attempt: job.jobAttempts + 1,
      dispatchId: newId(),
      now: sentAt,
    });
    const result = await sendDispatch({
      url: config.url,
      request,
      fetch: send,
      timeoutMs,
      now,
    });
    const finished = now();
    const update = decideOutcome(result, row.consecutiveFailures, finished);
    await dispatches.record(job.jobId, update, finished);
    report(job, update);
    return update;
  }

  /**
   * #395: after a call that failed with a transient answer, makes it again a few times with short pauses, within
   * the budget of the request. Returns as soon as the job is acknowledged, the answer is not transient, the budget
   * is used up or another sender took the job.
   */
  async function retryInline(
    job: JobToSend,
    first: DispatchUpdate,
    began: number,
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<void> {
    let update = first;
    for (const delay of retryDelays) {
      if (!TRANSIENT_CODES.includes(update.lastCode)) return;
      // What the Dispatcher asked to wait wins over our pause, but only a short wait is spent inside the request.
      const pause = Math.max(delay, update.retryAfterMs ?? 0);
      if (pause > INLINE_RETRY_MAX_WAIT_MS) return;
      if (monotonicMs() - began + pause + timeoutMs > INLINE_RETRY_BUDGET_MS)
        return;
      if (monotonicMs() + pause + timeoutMs > deadline) return;
      await sleep(pause);
      // The job may have been taken (or ended) in the meantime; the call is repeated only for a queued job.
      if ((await dispatches.dueJob(job.jobId, now())) === undefined) return;
      const row = await dispatches.get(job.jobId);
      if (row === undefined || row.state !== "pending") return;
      const next = await claimAndSend(job, row);
      if (next === false) return;
      update = next;
    }
  }

  /** Never throws: whatever fails is logged by its stable code, never by its message. */
  async function guarded<T>(
    jobId: string,
    fallback: T,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      log.error(
        `[dispatch] DISPATCH_FAILED job=${jobId}${errorCode(error) === undefined ? "" : ` code=${String(errorCode(error))}`}`,
      );
      return fallback;
    }
  }

  async function sendOne(
    job: JobToSend,
    {
      waiting = false,
      retryFrom,
      deadline,
    }: {
      waiting?: boolean;
      /** Repeat a transient failure inline, within the budget that started at this `monotonicMs()` (#395). */
      retryFrom?: number;
      /** No inline repeat is started that would end after this time of the monotonic clock. */
      deadline?: number;
    } = {},
  ): Promise<DispatchUpdate | false> {
    return guarded<DispatchUpdate | false>(job.jobId, false, async () => {
      let row = await dispatches.get(job.jobId);
      if (row === undefined) {
        // A queued job without a row: the hook never ran or lost its write. Due now.
        if (!(await dispatches.create(job.jobId, now()))) return false;
        row = await dispatches.get(job.jobId);
        if (row === undefined) return false;
      }
      // The listing this job came from may be older than the row: a sender that claimed it since (a lease
      // in the future) or recorded its answer (the next look in the future) has the job, whatever the
      // listing said. Only a row that is due now is ours to claim.
      // A job that was told "not now" (#395) is sent when a slot frees, whatever time its row says.
      if (
        row.state === "stopped" ||
        (!waiting && Date.parse(row.nextDispatchAt) > now().getTime())
      )
        return false;
      const update = await claimAndSend(job, row);
      if (update === false) return false;
      // A Dispatcher that is still busy with the launch that just failed answers `429`: ask again in a moment.
      if (retryFrom !== undefined)
        await retryInline(job, update, retryFrom, deadline);
      return update;
    });
  }

  /** Sends the jobs of a listing, a few at a time; how many were sent. */
  async function sendAll(
    jobs: DueDispatchJob[],
    sendEach: (job: DueDispatchJob) => Promise<DispatchUpdate | false>,
  ): Promise<number> {
    let sent = 0;
    const queue = [...jobs];
    await Promise.all(
      Array.from(
        { length: Math.min(SEND_CONCURRENCY, queue.length) },
        async () => {
          for (let job = queue.shift(); job !== undefined; job = queue.shift())
            if ((await sendEach(job)) !== false) sent += 1;
        },
      ),
    );
    return sent;
  }

  return {
    async onEnqueued(result, context = {}) {
      // A job that is returned because it exists already needs nothing, except the one a person pulled
      // forward (`already_active`): it was waiting behind a retry time and is due now.
      if (result.status === "existing" && result.reason !== "already_active")
        return;
      const { job } = result;
      if (job.status !== "queued") return;
      await guarded(job.id, undefined, async () => {
        const at = now();
        const due = Date.parse(job.runAfter) <= at.getTime();
        let row = await dispatches.get(job.id);
        if (row === undefined) {
          const created = await dispatches.create(
            job.id,
            due ? at : new Date(job.runAfter),
          );
          if (!created) return;
          row = await dispatches.get(job.id);
        }
        // Sent (or being sent) already: later calls are the next sender's. A job that is not due waits for it.
        if (row === undefined || row.attempts > 0 || row.state !== "pending")
          return;
        if (!due) return;
        const began = context.receivedAt ?? monotonicMs();
        const toSend = {
          jobId: job.id,
          reviewKind: job.reviewKind,
          jobAttempts: job.attempts,
        };
        const update = await claimAndSend(toSend, row);
        if (update !== false) await retryInline(toSend, update, began);
      });
    },

    sendJob: async (job) => (await sendOne(job)) !== false,

    async sendWaiting({ limit, first, deadline = Number.POSITIVE_INFINITY }) {
      if (limit <= 0) return { sent: 0 };
      let candidates: DueDispatchJob[];
      try {
        candidates = await dispatches.listWaiting(
          now(),
          DEFAULT_SEND_LIMIT,
          first,
        );
      } catch (error) {
        log.error(
          `[dispatch] DISPATCH_FAILED job=none${errorCode(error) === undefined ? "" : ` code=${String(errorCode(error))}`}`,
        );
        return { sent: 0 };
      }
      // One slot is one accepted wake-up: a job that is refused again (its pull request is busy, the pool is
      // full after all) does not use it, so the next candidate is asked, a batch of the missing number at a time.
      let accepted = 0;
      while (accepted < limit && candidates.length > 0) {
        // A send started now may take the longest a call takes: it must end before the deadline, not start before it.
        if (monotonicMs() + timeoutMs >= deadline) break;
        const batch = candidates.splice(
          0,
          Math.min(limit - accepted, SEND_CONCURRENCY),
        );
        const updates = await Promise.all(
          batch.map((job) => sendOne(job, { waiting: true, deadline })),
        );
        accepted += updates.filter(
          (update) => update !== false && update.lastCode === "accepted",
        ).length;
        // `busy`, `not ready`, a timeout or a lost connection say something about the Dispatcher, not about the job
        // that was asked: the other candidates would get the same answer. Only `not_claimable` (its own pull request,
        // the pool) is per job, and the walk goes on after it (#479).
        if (
          updates.some(
            (update) =>
              update !== false &&
              (TRANSIENT_CODES.includes(update.lastCode) ||
                update.lastCode === "ignored_busy"),
          )
        )
          break;
      }
      return { sent: accepted };
    },

    async redispatch(jobId, { deadline = Number.POSITIVE_INFINITY } = {}) {
      await guarded(jobId, undefined, async () => {
        const began = monotonicMs();
        const at = now();
        const runAfter = await dispatches.resetForResend(jobId, at);
        if (runAfter === undefined) return;
        // The retry time of the job (the Dispatcher gives a job back with 30 seconds) is waited for inside this
        // request when it fits before the deadline and the limit of the function; else the next sender sends it.
        const wait = Math.max(0, runAfter.getTime() - at.getTime());
        if (wait > REDISPATCH_MAX_WAIT_MS) return;
        if (wait > 0) {
          if (monotonicMs() + wait + REDISPATCH_SLACK_MS + timeoutMs > deadline)
            return;
          await sleep(wait + REDISPATCH_SLACK_MS);
        }
        const job = await dispatches.dueJob(jobId, now());
        if (job !== undefined)
          await sendOne(job, { retryFrom: began, deadline });
      });
    },

    async sendDue(limit = DEFAULT_SEND_LIMIT, { minAgeMs = 0 } = {}) {
      let due: DueDispatchJob[];
      try {
        due = await dispatches.listDue(now(), limit, minAgeMs);
      } catch (error) {
        log.error(
          `[dispatch] DISPATCH_FAILED job=none${errorCode(error) === undefined ? "" : ` code=${String(errorCode(error))}`}`,
        );
        return { sent: 0 };
      }
      return { sent: await sendAll(due, (job) => sendOne(job)) };
    },
  };
}
