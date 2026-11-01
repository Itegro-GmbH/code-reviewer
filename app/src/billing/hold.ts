// SPDX-License-Identifier: LicenseRef-Proprietary

// What a hold is made for (ADR 0006, 2.8 and D6; #498): the longest a job can occupy a VM, and the most its model cost can
// be bounded to. The times are constants because the App cannot read the settings of a Dispatcher; each is the default of
// the place that owns it, and a test pins it there (`hold.test.ts` reads those places, and
// `dispatcher/src/billing-hold-pin.test.ts` reads this file). An operator who raises a setting above its default makes the
// hold smaller than the real maximum, never larger; the settlement charges the real price in any case.
import "server-only";
import type { JobKind } from "../job-kind/job-kind.ts";

/** `DISPATCHER_JOB_TIMEOUT_SECONDS` of the Dispatcher (`dispatcher/src/config.ts`): how long a Worker of a Diff job may live. */
export const DIFF_JOB_TIMEOUT_SECONDS = 1200;
/**
 * The same setting for a Dynamic job. Its engine stops at 600 s on its own, but the VM is sized by the Dispatcher's one
 * timeout whatever the kind, so that is the longest it lives.
 */
export const DYNAMIC_JOB_TIMEOUT_SECONDS = 1200;
/** `SANDBOX_VM_TIMEOUT_MARGIN_SECONDS` of the Dispatcher (`dispatcher/src/launchers/sandbox.ts`): the VM's own timeout is the job's plus this. */
export const VM_TIMEOUT_MARGIN_SECONDS = 300;

/**
 * The per-kind job timeout of the Dispatcher for a turn of the Implementer (#752): an hour, where a review lives 20 minutes.
 * The Dispatcher's side comes with its own change (#759); the app's hard timeout of a turn (`DEFAULT_IMPLEMENTER_MAX_RUNTIME_MS`) is this
 * plus 10 minutes of grace.
 */
export const IMPLEMENTER_JOB_TIMEOUT_SECONDS = 3600;

export const JOB_TIMEOUT_SECONDS: Record<JobKind, number> = {
  diff: DIFF_JOB_TIMEOUT_SECONDS,
  dynamic: DYNAMIC_JOB_TIMEOUT_SECONDS,
  implementer: IMPLEMENTER_JOB_TIMEOUT_SECONDS,
};

// The cost limit of a run is not a constant here since #689: it is the operator's maximum per review, set in the admin portal
// (the instance setting `review_max_cost_cents`, `review-settings/operator-cost-limit.ts`), and a caller of `reserveFor` passes
// it as `dynamicCostLimitMicroUsd` (cents x 10,000). A run can cost more than the limit by the excess of #540, and then
// settlement charges the real price.

const MINUTE_SECONDS = 60;

/** The longest a VM of a job of this kind lives, in whole started minutes: the job timeout plus the VM margin, rounded up. */
export function maxVmMinutes(kind: JobKind): number {
  return Math.ceil(
    (JOB_TIMEOUT_SECONDS[kind] + VM_TIMEOUT_MARGIN_SECONDS) / MINUTE_SECONDS,
  );
}
