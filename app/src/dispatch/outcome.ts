// SPDX-License-Identifier: LicenseRef-Proprietary

// What an answer of the Dispatcher (or the lack of one) means for the dispatch of a job: acknowledged,
// look again later, or stop. Pure: the answer, the failures so far and the clock come in, the new state of
// the `job_dispatches` row comes out. The schedule follows #326: 10 s, 30 s, 2 min, 5 min, then 15 min
// after a 5xx or a timeout; `Retry-After` of a 429 or 503 wins when it is longer; any other answer waits
// long and raises an alert (never a hot loop).
import type { SendResult } from "./send.ts";

/** How long a 202 or a `not_claimable` is trusted before the job is looked at again (still queued: resend). */
export const ACK_TIMEOUT_MS = 2 * 60_000;
export const BACKOFF_SCHEDULE_MS = [10_000, 30_000, 120_000, 300_000] as const;
const BACKOFF_FINAL_MS = 15 * 60_000;
/** After an answer the contract does not describe (400, 401, 404, a redirect, ...): wait, and alert. */
export const REJECTED_BACKOFF_MS = 30 * 60_000;
/**
 * #972: how long a dispatcher that answered `busy` (it is full and forgets the bell) is left alone. It claims by itself when a slot
 * frees; the app rings it again when a job of its label group ends (an event) and, at the latest, in the sweep, which runs every
 * two hours (`app/vercel.json`). No timer and no request rings it sooner.
 */
export const BUSY_REST_MS = 2 * 60 * 60_000;
/** A `Retry-After` beyond this is cut: a typo in the header must not park a job for a day. */
export const MAX_RETRY_AFTER_SECONDS = 3600;

export const DISPATCH_STATES = ["pending", "acked", "stopped"] as const;
/** `pending`: to be sent (again) at `nextDispatchAt`; `acked`: the Dispatcher said 202; `stopped`: never again. */
export type DispatchState = (typeof DISPATCH_STATES)[number];

/** Stable names of the last answer; stored, so a name is never renamed or reused. */
export const DISPATCH_RESULT_CODES = [
  "accepted",
  "ignored_not_claimable",
  "ignored_not_capable",
  /** #972: the dispatcher is full (reason `busy`). */
  "ignored_busy",
  "rate_limited",
  "unavailable",
  "server_error",
  "timeout",
  "network_error",
  "rejected",
] as const;
export type DispatchResultCode = (typeof DISPATCH_RESULT_CODES)[number];

export type DispatchUpdate = {
  state: DispatchState;
  nextDispatchAt: Date;
  /** Failed sends in a row, including this one; a success resets it. */
  consecutiveFailures: number;
  /** True when this send was a 202 (the row's `acked_at` is set to now). */
  acknowledged: boolean;
  /** The HTTP status, null when there was no answer. */
  lastStatus: number | null;
  lastCode: DispatchResultCode;
  /** True for an answer an operator has to look at (the code is logged at error level). */
  alert: boolean;
  /** What the Dispatcher asked to wait (`Retry-After`), cut to `MAX_RETRY_AFTER_SECONDS`; left out when it asked none. */
  retryAfterMs?: number;
};

/** The wait after the `failures`-th failure in a row (1 for the first). */
export function failureDelayMs(failures: number): number {
  return BACKOFF_SCHEDULE_MS[failures - 1] ?? BACKOFF_FINAL_MS;
}

export function decideOutcome(
  result: SendResult,
  failuresBefore: number,
  now: Date,
): DispatchUpdate {
  const at = (ms: number) => new Date(now.getTime() + ms);
  const failures = failuresBefore + 1;
  const failure = (
    lastCode: DispatchResultCode,
    lastStatus: number | null,
    delayMs: number,
    alert = false,
    retryAfterMs = 0,
  ): DispatchUpdate => ({
    state: "pending",
    nextDispatchAt: at(delayMs),
    consecutiveFailures: failures,
    acknowledged: false,
    lastStatus,
    lastCode,
    alert,
    ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
  });

  switch (result.kind) {
    case "accepted":
      return {
        state: "acked",
        nextDispatchAt: at(ACK_TIMEOUT_MS),
        consecutiveFailures: 0,
        acknowledged: true,
        lastStatus: 202,
        lastCode: "accepted",
        alert: false,
      };
    case "ignored":
      // #972: a full dispatcher forgets the bell and claims by itself when a slot frees: no timer rings it again.
      if (result.reason === "busy")
        return {
          state: "pending",
          nextDispatchAt: at(BUSY_REST_MS),
          consecutiveFailures: 0,
          acknowledged: false,
          lastStatus: 200,
          lastCode: "ignored_busy",
          alert: false,
        };
      // Any other reason but `not_capable` is read as `not_claimable` (a reader accepts any reason of the right form).
      return result.reason === "not_capable"
        ? {
            state: "stopped",
            nextDispatchAt: at(ACK_TIMEOUT_MS),
            consecutiveFailures: 0,
            acknowledged: false,
            lastStatus: 200,
            lastCode: "ignored_not_capable",
            alert: false,
          }
        : {
            state: "pending",
            nextDispatchAt: at(ACK_TIMEOUT_MS),
            consecutiveFailures: 0,
            acknowledged: false,
            lastStatus: 200,
            lastCode: "ignored_not_claimable",
            alert: false,
          };
    case "retry_later": {
      const header =
        Math.min(result.retryAfterSeconds ?? 0, MAX_RETRY_AFTER_SECONDS) * 1000;
      return failure(
        result.status === 429 ? "rate_limited" : "unavailable",
        result.status,
        Math.max(failureDelayMs(failures), header),
        false,
        header,
      );
    }
    case "server_error":
      return failure("server_error", result.status, failureDelayMs(failures));
    case "timeout":
      return failure("timeout", null, failureDelayMs(failures));
    case "network_error":
      return failure("network_error", null, failureDelayMs(failures));
    case "rejected":
      return failure("rejected", result.status, REJECTED_BACKOFF_MS, true);
  }
}
