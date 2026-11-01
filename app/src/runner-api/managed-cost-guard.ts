// SPDX-License-Identifier: LicenseRef-Proprietary

// The rule that a managed Dynamic run (and, since #754, a managed turn of the Implementer, which runs the same native way) never settles with an unknown cost (#553; epic #489: "the managed key is never used
// with an unknown price"). On the managed key we pay, so the price is known before the job starts (the claim carries the
// confirmed book) and the runner ends the run with `dynamic_accounting_failed` when a call's cost cannot be read. A result
// that still claims a success with a null cost is not trusted: it is stored as that failure, which billing treats as our fault
// (free), instead of a success the customer would be charged minutes for while nobody can say what it cost us. A Dynamic result that
// reports no usage at all is left as it is: that is how an older runner and a usage that was dropped as malformed arrive, and
// it settles with an unknown cost as it always did; a turn of the Implementer is held to the rule without that leniency. Pure.
import type { RunnerResult } from "./contract.ts";

/** The kinds whose runs go through the native passthrough proxy and its cost ledger; a Diff Review never did. */
const COST_ACCOUNTED_KINDS: readonly string[] = ["dynamic", "implementer"];

export const UNACCOUNTED_MANAGED_RUN_MESSAGE =
  "the cost of the run could not be accounted for";

/**
 * The result as it is stored: unchanged, unless the job ran on the operator's key, is a **native** Dynamic review or Implementer turn (the claim
 * gave it a price book and the runner promised to account for every call; a job on the legacy wires never did), claims to have
 * succeeded and reports a usage with a null cost. A failure keeps the runner's code: its cost may well be unknown, and the
 * code decides how it bills.
 */
export function withoutUnaccountedManagedSuccess(
  result: RunnerResult,
  job: { managed: boolean; native: boolean; reviewKind: string },
): RunnerResult {
  if (
    !job.managed ||
    !job.native ||
    !COST_ACCOUNTED_KINDS.includes(job.reviewKind)
  )
    return result;
  if (result.errorCode !== null) return result;
  // A turn of the Implementer that reports no usage at all is not trusted either (#754): it would settle with no cost while the
  // operator pays the model. Dynamic keeps its pinned behaviour (older runners and dropped usages arrive that way).
  const noUsageAllowed = job.reviewKind !== "implementer";
  if (result.usage === null ? noUsageAllowed : result.usage.costUsd !== null)
    return result;
  return {
    ...result,
    ok: false,
    errorCode: "dynamic_accounting_failed",
    errorMessage: UNACCOUNTED_MANAGED_RUN_MESSAGE,
  };
}
