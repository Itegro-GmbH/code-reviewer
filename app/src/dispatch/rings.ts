// SPDX-License-Identifier: LicenseRef-Proprietary

// The doorbell to the webhook dispatchers of customers (#972, Runner v2, ADR 0005). A customer's dispatcher announced `delivery: webhook`
// (src/runner-identity/delivery.ts); the app rings it, with the signed wake-up call of `contracts/dispatch-webhook.v1.json` and the
// signing secret of THAT dispatcher, when a job it could take is waiting. The call is only a doorbell: it names the job and carries no
// job data, the dispatcher answers at once (202 it will look, 200 ignored with a reason, 429 or 503 with `Retry-After`) and claims the next
// matching job itself. A job goes to every dispatcher that matches (the workspace and every label the job requires); whoever claims first
// wins and the others get 204 from the claim. A dispatcher that polls is never rung.
//
// Three moments ring, and all three are idempotent in the row of the pair (`job_rings`, a compare and set on `next_dispatch_at`
// as for the platform's dispatcher, so two instances never ring the same pair twice, and the same back-off applies):
//
// - `onEnqueued`: a job was enqueued. The hook of the queue, after the response, never throws.
// - `ringGroupsOf`: the claims of these jobs ended (a result, a failure, a cancel, a lapsed lease, a timeout). A slot freed in their label group,
//   so the waiting jobs that group can take are rung again: the pairs whose last ring was answered "not now" (a dispatcher that said `busy`
//   forgets the bell, so this is how it hears of work again if it does not claim by itself). Bounded: at most `RING_LIMIT` pairs, a dispatcher that
//   says it is busy or cannot be reached is asked no more in this reaction, and a pair is rung again only `WAITING_MIN_GAP_MS` after its last call.
// - `ringDue`: the sweep and the repair work of the requests that touch the database: the pairs with no row yet or whose row is due. The
//   rare safety net.
//
// Nothing here schedules itself and nothing here can lose a job: the job is durable before any of this runs.
import "server-only";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import {
  createRunnerDispatchesRepository,
  type LabelGroup,
  type RingPair,
  type RunnerDispatchesRepository,
} from "../db/repositories/runner-dispatches-repository.ts";
import { errorCode } from "../db/errors.ts";
import type { Database } from "../db/schema.ts";
import type { EnqueueResult } from "../jobs/job-types.ts";
import { OPENCODE_HARNESS, readyHarnesses } from "../runner-identity/harness.ts";
import { meetsMinimum } from "../runner-identity/versions.ts";
import {
  decideOutcome,
  type DispatchResultCode,
  type DispatchUpdate,
} from "./outcome.ts";
import { buildDispatchRequest } from "./request.ts";
import { DISPATCH_TIMEOUT_MS, sendDispatch, type DispatchFetch } from "./send.ts";

/** How long a claimed ring holds its row: the request limit plus time to store the answer. */
export const RING_LEASE_MS = 30_000;
/** The most pairs one reaction or one sweep rings. */
export const RING_LIMIT = 20;
const RING_CONCURRENCY = 5;
/** The answers that say something about the dispatcher, not about the job: the other jobs would get the same. */
const DISPATCHER_WIDE_CODES: readonly DispatchResultCode[] = [
  "ignored_busy",
  "rate_limited",
  "unavailable",
  "server_error",
  "timeout",
  "network_error",
];

export type RingLog = {
  /** A ring that failed and will be made again. */
  warn(line: string): void;
  /** An answer an operator has to look at. */
  error(line: string): void;
};

export type RingService = {
  /** The hook of the job queue. Never rejects. */
  onEnqueued(result: EnqueueResult): Promise<void>;
  /** Rings the pairs that are due (see above); how many were rung. `minAgeMs` leaves a job that changed less long ago to the request that queued it. Never rejects. */
  ringDue(
    limit?: number,
    options?: { minAgeMs?: number },
  ): Promise<{ rung: number }>;
  /** The claims of these jobs ended: rings the waiting jobs of the groups they freed a slot in; how many were rung. Never rejects. */
  ringGroupsOf(jobIds: readonly string[]): Promise<{ rung: number }>;
  /** Makes the pairs a dispatcher stopped long enough ago pending again. */
  reviveStopped(stoppedBefore: Date, at: Date): Promise<number>;
};

export function createRingService(options: {
  db: Kysely<Database>;
  /** The secret of a stored delivery (`openDeliverySecret` with the app's secret); throws for one that cannot be read. */
  openSecret: (runnerId: string, sealedSecret: string) => string;
  /** The oldest base the app accepts, or null; a dispatcher below it gets no job and no ring. */
  minBaseVersion?: () => string | null;
  /** The rows of the pairs, instead of the database (tests). */
  dispatches?: RunnerDispatchesRepository;
  fetch?: DispatchFetch;
  now?: () => Date;
  newId?: () => string;
  timeoutMs?: number;
  log?: RingLog;
}): RingService {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DISPATCH_TIMEOUT_MS;
  const minBaseVersion = options.minBaseVersion ?? (() => null);
  const log: RingLog = options.log ?? {
    warn: (line) => console.warn(line),
    error: (line) => console.error(line),
  };
  const dispatches =
    options.dispatches ?? createRunnerDispatchesRepository(options.db, now);

  /** Logs a ring that failed: the stable code and the numbers, never the address, the key or what the answer said. */
  function report(pair: RingPair, update: DispatchUpdate): void {
    if (update.lastCode === "accepted" || update.state === "stopped") return;
    const status =
      update.lastStatus === null ? "none" : String(update.lastStatus);
    const who = `job=${pair.jobId} runner=${pair.runnerId}`;
    if (update.alert) {
      log.error(
        `[dispatch] RING_REJECTED ${who} code=${update.lastCode} status=${status} retry_at=${update.nextDispatchAt.toISOString()}: check the delivery the runner announced`,
      );
      return;
    }
    // A dispatcher that is full or turned the job away says nothing is wrong.
    if (update.consecutiveFailures === 0) return;
    log.warn(
      `[dispatch] RING_SEND_FAILED ${who} code=${update.lastCode} status=${status} failures=${String(update.consecutiveFailures)} retry_at=${update.nextDispatchAt.toISOString()}`,
    );
  }

  /** Whether the dispatcher could take the job at all: the harness and the version are judged here, the labels in the listing. */
  function capable(pair: RingPair): boolean {
    const harnesses = readyHarnesses(pair.manifest);
    if (!harnesses.includes(OPENCODE_HARNESS)) return false;
    if (!harnesses.includes(pair.harness)) return false;
    const minimum = minBaseVersion();
    return minimum === null || meetsMinimum(pair.baseVersion, minimum);
  }

  /** Rings one pair. False when another sender holds it or it needs no ring now; else what the answer came to. */
  async function ringPair(
    pair: RingPair,
    { waiting = false }: { waiting?: boolean } = {},
  ): Promise<DispatchUpdate | false> {
    try {
      let row = await dispatches.get(pair.jobId, pair.runnerId);
      if (row === undefined) {
        if (!(await dispatches.create(pair.jobId, pair.runnerId, now())))
          return false;
        row = await dispatches.get(pair.jobId, pair.runnerId);
        if (row === undefined) return false;
      }
      // The listing may be older than the row: a sender that claimed it since (a lease in the future) or recorded its answer has the pair.
      // A pair that was told "not now" is rung when a slot frees, whatever time its row says.
      if (
        row.state === "stopped" ||
        (!waiting && Date.parse(row.nextDispatchAt) > now().getTime())
      )
        return false;

      if (!capable(pair)) {
        // A dispatcher that cannot run the job (its harness, a version below the minimum) is not asked; the sweep looks again after a while.
        const update = decideOutcome(
          { kind: "ignored", reason: "not_capable" },
          row.consecutiveFailures,
          now(),
        );
        await dispatches.record(pair.jobId, pair.runnerId, update, now());
        return false;
      }

      let secret: string;
      try {
        secret = options.openSecret(pair.runnerId, pair.delivery.sealedSecret);
      } catch {
        // Another APP_SECRET or a changed row: the dispatcher cannot be rung until it announces its delivery again with a new secret.
        const claimed = await dispatches.claimSend(
          pair.jobId,
          pair.runnerId,
          row.nextDispatchAt,
          new Date(now().getTime() + RING_LEASE_MS),
        );
        if (!claimed) return false;
        const update: DispatchUpdate = {
          ...decideOutcome(
            { kind: "rejected", status: 0 },
            row.consecutiveFailures,
            now(),
          ),
          lastStatus: null,
        };
        await dispatches.record(pair.jobId, pair.runnerId, update, now());
        report(pair, update);
        return update;
      }

      const claimed = await dispatches.claimSend(
        pair.jobId,
        pair.runnerId,
        row.nextDispatchAt,
        new Date(now().getTime() + RING_LEASE_MS),
      );
      if (!claimed) return false;

      const request = buildDispatchRequest({
        key: { kid: pair.delivery.keyId, secret },
        jobId: pair.jobId,
        reviewKind: pair.reviewKind,
        attempt: pair.jobAttempts + 1,
        dispatchId: newId(),
        now: now(),
      });
      const result = await sendDispatch({
        url: pair.delivery.url,
        request,
        fetch: send,
        timeoutMs,
        now,
      });
      const finished = now();
      const update = decideOutcome(result, row.consecutiveFailures, finished);
      await dispatches.record(pair.jobId, pair.runnerId, update, finished);
      report(pair, update);
      return update;
    } catch (error) {
      log.error(
        `[dispatch] RING_FAILED job=${pair.jobId} runner=${pair.runnerId}${errorCode(error) === undefined ? "" : ` code=${String(errorCode(error))}`}`,
      );
      return false;
    }
  }

  /**
   * Rings the pairs: the dispatchers a few at a time, the pairs of one dispatcher one after the other. A dispatcher whose answer says
   * something about itself (it is full, not reachable, it asks to wait) is not asked again in this run: its other jobs would get the same
   * answer. Returns how many pairs were rung.
   */
  async function ringAll(
    pairs: RingPair[],
    { waiting }: { waiting: boolean },
  ): Promise<number> {
    let rung = 0;
    const byDispatcher = new Map<string, RingPair[]>();
    for (const pair of pairs)
      byDispatcher.set(pair.runnerId, [
        ...(byDispatcher.get(pair.runnerId) ?? []),
        pair,
      ]);
    const queue = [...byDispatcher.values()];
    await Promise.all(
      Array.from(
        { length: Math.min(RING_CONCURRENCY, queue.length) },
        async () => {
          for (let own = queue.shift(); own !== undefined; own = queue.shift())
            for (const pair of own) {
              const update = await ringPair(pair, { waiting });
              if (update === false) continue;
              rung += 1;
              if (DISPATCHER_WIDE_CODES.includes(update.lastCode)) break;
            }
        },
      ),
    );
    return rung;
  }

  async function guarded<T>(
    what: string,
    fallback: T,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      log.error(
        `[dispatch] RING_FAILED ${what}${errorCode(error) === undefined ? "" : ` code=${String(errorCode(error))}`}`,
      );
      return fallback;
    }
  }

  return {
    async onEnqueued(result) {
      // A job that is returned because it exists already needs nothing, except the one a person pulled forward (`already_active`).
      if (result.status === "existing" && result.reason !== "already_active")
        return;
      const { job } = result;
      if (job.status !== "queued") return;
      await guarded(`job=${job.id}`, undefined, async () => {
        const due = await dispatches.listDue(now(), RING_LIMIT, {
          jobId: job.id,
        });
        await ringAll(due, { waiting: false });
      });
    },

    async ringDue(limit = RING_LIMIT, { minAgeMs = 0 } = {}) {
      return guarded("job=none", { rung: 0 }, async () => {
        const due = await dispatches.listDue(now(), limit, { minAgeMs });
        return { rung: await ringAll(due, { waiting: false }) };
      });
    },

    async ringGroupsOf(jobIds) {
      return guarded("job=none", { rung: 0 }, async () => {
        const ended = await dispatches.endedGroups(jobIds);
        // One group for each workspace: the labels of the jobs that ended and of the runners that held them. A freed slot can serve a
        // waiting job whose labels all are among them.
        const groups = new Map<string, Set<string>>();
        for (const job of ended) {
          const labels = groups.get(job.workspaceId) ?? new Set<string>();
          for (const label of [...job.requiredLabels, ...job.holderLabels])
            labels.add(label);
          groups.set(job.workspaceId, labels);
        }
        let rung = 0;
        for (const [workspaceId, labels] of groups) {
          if (rung >= RING_LIMIT) break;
          const group: LabelGroup = { workspaceId, labels: [...labels] };
          const waiting = await dispatches.listWaiting(
            now(),
            RING_LIMIT - rung,
            group,
          );
          rung += await ringAll(waiting, { waiting: true });
        }
        return { rung };
      });
    },

    reviveStopped: (stoppedBefore, at) =>
      guarded("job=none", 0, () => dispatches.reviveStopped(stoppedBefore, at)),
  };
}
