// SPDX-License-Identifier: LicenseRef-Proprietary

// The settings of the runner fleet (#854), read from the environment on every use: the one place that knows the names. Never fails: a
// value that cannot be used counts as not set, so a typo cannot lock every runner out or keep a job waiting for ever.
//
// | Variable                    | Meaning                                                                                                      |
// | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
// | RUNNER_MIN_BASE_VERSION     | The oldest version of the base (`1.4.0`) a customer's runner may have and still get jobs. Unset: no minimum. |
// | RUNNER_DELIVERY_ALLOW_LOOPBACK | `1`: a webhook dispatcher may announce an address on this machine, with plain http (the fakes, the E2E, local development). Never set in production. Unset: https to a public address only. |
import { BASE_VERSION_PATTERN } from "./announcement.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** A runner that was not heard from for this long is offline. The runner asks for a job about every 30 seconds. */
export const ONLINE_WITHIN_SECONDS = 120;

/** The minimum version of the base, or null for none (also for a value that is not a version). */
export function minimumBaseVersion(env: Env): string | null {
  const text = env.RUNNER_MIN_BASE_VERSION?.trim();
  return text !== undefined && BASE_VERSION_PATTERN.test(text) ? text : null;
}

/** Whether a webhook dispatcher may announce an address on this machine (`RUNNER_DELIVERY_ALLOW_LOOPBACK=1`). Off unless it is exactly `1`. */
export function deliveryAllowsLoopback(env: Env): boolean {
  return env.RUNNER_DELIVERY_ALLOW_LOOPBACK?.trim() === "1";
}
