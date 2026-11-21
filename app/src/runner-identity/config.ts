// SPDX-License-Identifier: LicenseRef-Proprietary

// The settings of the runner fleet (#854), read from the environment on every use: the one place that knows the names. Never fails: a
// value that cannot be used counts as not set, so a typo cannot lock every runner out or keep a job waiting for ever.
//
// | Variable                    | Meaning                                                                                                      |
// | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
// | RUNNER_MIN_BASE_VERSION     | The oldest version of the base (`1.4.0`) a customer's runner may have and still get jobs. Unset: no minimum. |
// | RUNNER_MAX_PARALLEL_RUNS    | The most turns one self-hosted runner may run at the same time (`parallelRuns` is held within it). Default 16. |
// | RUNNER_DELIVERY_ALLOW_LOOPBACK | `1`: a webhook dispatcher may announce an address on this machine, with plain http (the fakes, the E2E, local development). Never set in production. Unset: https to a public address only. |
import { BASE_VERSION_PATTERN } from "./announcement.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** A runner that was not heard from for this long is offline. The runner asks for a job about every 30 seconds. */
export const ONLINE_WITHIN_SECONDS = 120;

/** How many turns one self-hosted runner may run at the same time at most, whatever it announces: the operator's maximum (#1105). */
export const DEFAULT_MAX_PARALLEL_RUNS = 16;

/**
 * The operator's maximum of `parallelRuns` for one runner (`RUNNER_MAX_PARALLEL_RUNS`, a whole number from 1 to 1000; 16 when it is not
 * set or is anything else, so a typo never lifts the bound or stops every runner).
 */
export function maxParallelRuns(env: Env): number {
  const text = env.RUNNER_MAX_PARALLEL_RUNS?.trim();
  if (text === undefined || !/^[0-9]{1,4}$/.test(text))
    return DEFAULT_MAX_PARALLEL_RUNS;
  const value = Number(text);
  return value >= 1 && value <= 1000 ? value : DEFAULT_MAX_PARALLEL_RUNS;
}

/**
 * How many turns a self-hosted runner may run at the same time (ADR 0007, "Concurrency"): the `parallelRuns` it announced, held within
 * the operator's maximum; a runner that announced none gets the maximum (it works as before, and its own dispatcher caps itself).
 */
export function runnerConcurrency(
  limits: { parallelRuns?: number },
  env: Env,
): number {
  const max = maxParallelRuns(env);
  return Math.min(limits.parallelRuns ?? max, max);
}

/** The minimum version of the base, or null for none (also for a value that is not a version). */
export function minimumBaseVersion(env: Env): string | null {
  const text = env.RUNNER_MIN_BASE_VERSION?.trim();
  return text !== undefined && BASE_VERSION_PATTERN.test(text) ? text : null;
}

/** Whether a webhook dispatcher may announce an address on this machine (`RUNNER_DELIVERY_ALLOW_LOOPBACK=1`). Off unless it is exactly `1`. */
export function deliveryAllowsLoopback(env: Env): boolean {
  return env.RUNNER_DELIVERY_ALLOW_LOOPBACK?.trim() === "1";
}
