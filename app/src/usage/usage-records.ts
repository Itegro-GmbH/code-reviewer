// SPDX-License-Identifier: LicenseRef-Proprietary

// The vocabulary of usage records (src/usage/README.md): what one run consumed, kept per job so limits, the usage
// page and the operator API can count it. Pure: no database, no clock. The table is `usage_records`, the
// repository `src/db/repositories/usage-records-repository.ts`.
import type { JobOutcome } from "../jobs/job-types.ts";
import type { LlmAccessSource } from "../llm/access.ts";
import type { KeyMode } from "../workspaces/entitlements.ts";

/**
 * The life of a record. `reserved` from the claim of the job, then `settled` (the run is counted, with
 * the cost and tokens it reported) or `void` (no model was used, nothing is counted). `settled` and `void`
 * are final. `reserved` and `settled` count towards a limit, `void` does not.
 */
export const USAGE_STATES = ["reserved", "settled", "void"] as const;
export type UsageState = (typeof USAGE_STATES)[number];

/**
 * Whether the money of a run is still to be settled (#605, `usage_records.billing_state`). `open`: the claim that handed the
 * job out had billing on, nothing is held, and the price is charged once when the job ends. `settled`: that happened (a charge,
 * or none when the run is free). A record that was never `open` (the job was claimed with billing off) is null and is never
 * charged.
 */
export const BILLING_STATES = ["open", "settled"] as const;
export type BillingState = (typeof BILLING_STATES)[number];

/**
 * Why a record was settled without a report of its run. `no_result`: the job ended without any result from the
 * runner (it died, its lease ran out on the last attempt, it ran past the hard limit), so the model may have been
 * used and nobody can say how much: the record counts, with an unknown cost and unknown tokens. A run that
 * reported its usage, failed or not, has no reason.
 *
 * `superseded` (#397): a newer push replaced the run while it ran. It is not a run of the quota (it is left out of the
 * run counts and the limits on runs), but what it consumed is usage like any other: the record carries the cost and
 * tokens the run reported, an unknown cost stays unknown, and a cost limit still counts the known cost. The record
 * is marked when the run is superseded (while it is still `reserved`, draining) and settled when the Worker reports
 * or the drain ends.
 */
export const SETTLED_REASONS = ["no_result", "superseded"] as const;
export type SettledReason = (typeof SETTLED_REASONS)[number];

/**
 * The error codes a job ends with when a runner held it and no result arrived (`lease_expired` and `timeout` are the
 * queue's own, `runner_shutdown` is a runner that was stopped and gave the job back on its last attempt, `runner_revoked`
 * is a customer's runner removed while it held the job). Any other
 * way for a job to end without `complete` (cancelled, replaced, never started, given back before the runner began)
 * made no model call anybody knows of: its record is void.
 */
export const NO_RESULT_JOB_ERROR_CODES = [
  "lease_expired",
  "timeout",
  "runner_shutdown",
  "runner_revoked",
] as const;

/**
 * How to read the missing cost of a settled record (#856): `subscription` is a turn that ran on the login of a customer's device. It
 * has no cost, which is not a cost nobody could measure: it is never counted or reported as an unknown cost (#361, #385), it adds
 * nothing to a sum, and it is never billed. Its estimate at API prices is shown on the run and not kept here.
 */
export const USAGE_COST_BASES = ["subscription"] as const;
export type UsageCostBasis = (typeof USAGE_COST_BASES)[number];

/**
 * What the caller knows about the job from its own records (#856), never from the report: the basis a report names is the runner's
 * word, and any runner or Worker could mark any job as one that has no cost to know. `subscription` is true only for a turn of the
 * Implementer on the harness `claude-code` that ran on a customer's runner (`isSubscriptionTurn`); without it the basis is not taken.
 */
export type SettlementTrust = { subscription?: boolean };

/** Whose key a run was made with. The same two values as the key mode of the entitlements. */
export type UsageKeyMode = KeyMode;

/**
 * A run that settled without a known cost (#361): the cost limits do not bound it, so it is reported (a log line, ids
 * only) to be watched. Never carries a figure, a model or a name.
 */
export type UnknownCostSettlement = { workspaceId: string; jobId: string };

/** Cost is stored as a whole number of millionths of a US dollar. */
const MICRO_USD_PER_USD = 1_000_000;

/**
 * The largest cost or token count a record stores: the columns are 32 bit integers on Postgres. A larger number
 * is not a plausible measurement of one run; it is stored as unknown instead of failing the completion.
 */
export const MAX_STORED_AMOUNT = 2_147_483_647;

/**
 * `costUsd` times one million, rounded half up; null for a value no record can hold (not a finite
 * non-negative number, or more than a record stores). The product is cut to 15
 * significant digits first, so a binary value that sits just below a half (0.0000005 * 1e6) still
 * rounds up, as it would on paper.
 */
export function costUsdToMicroUsd(costUsd: number): number | null {
  if (!Number.isFinite(costUsd) || costUsd < 0) return null;
  const micro = Math.floor(
    Number((costUsd * MICRO_USD_PER_USD).toPrecision(15)) + 0.5,
  );
  return micro <= MAX_STORED_AMOUNT ? micro : null;
}

/** `own` for the workspace's key, `managed` for the operator's (the source of the resolved LLM access). */
export function keyModeOfAccessSource(source: LlmAccessSource): UsageKeyMode {
  return source === "operator" ? "managed" : "own";
}

/** What completing a job does to its record. */
export type UsageSettlement =
  | { state: "void" }
  | {
      state: "settled";
      /** Null when the runner could not measure it (a cost is never guessed). */
      costMicroUsd: number | null;
      promptTokens: number | null;
      completionTokens: number | null;
      /** Why it was settled without a report of its run; absent when the run reported. */
      reason?: SettledReason;
      /** Present for a turn that ran through a subscription (#856); it has no cost and is not an unknown one. */
      costBasis?: UsageCostBasis;
    };

type ReportedUsage = {
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  /** Null when the runner did not say (it is not needed to settle). */
  aiCalls: number | null;
  /** `subscription` only for a usage without a cost (#856): a basis beside a cost is not trusted. */
  costBasis: UsageCostBasis | null;
};

function isCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_STORED_AMOUNT
  );
}

/** The usage inside a stored result, or null when there is none or it is not what the runner API promises. */
function reportedUsage(result: unknown): ReportedUsage | null {
  if (typeof result !== "object" || result === null) return null;
  const usage = (result as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const { promptTokens, completionTokens, costUsd, aiCalls, costBasis } =
    usage as Record<string, unknown>;
  if (!isCount(promptTokens) || !isCount(completionTokens)) return null;
  const calls = isCount(aiCalls) ? aiCalls : null;
  if (costUsd === null)
    return {
      promptTokens,
      completionTokens,
      costUsd: null,
      aiCalls: calls,
      costBasis: costBasis === "subscription" ? "subscription" : null,
    };
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0)
    return null;
  return {
    promptTokens,
    completionTokens,
    costUsd,
    aiCalls: calls,
    costBasis: null,
  };
}

/** Whether the result carries a usage at all, readable or not. */
function carriesUsage(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const usage = (result as { usage?: unknown }).usage;
  return usage !== undefined && usage !== null;
}

/**
 * The reasons the loop of a runner gives (`errorReason`) when it ends a job process that held the job and left no
 * usable result: killed, no result line, past the hard timeout, or a usage it could not read.
 */
export const NO_RESULT_ERROR_REASONS: readonly string[] = [
  "no_result_from_process",
  "unreadable_usage",
];

function errorReasonOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const reason = (result as { errorReason?: unknown }).errorReason;
  return typeof reason === "string" ? reason : null;
}

/**
 * How the result of a run that was superseded settles its record (#397): as any result does (the usage it reported,
 * its cost exact or unknown), with the reason `superseded` so that it is not counted as a run. A result without a
 * usage that shows no call leaves the record void, as for any run. A run that was ended without a usable result
 * (the host ended its process) is settled with everything unknown.
 */
export function settlementOfSupersededOutcome(
  outcome: JobOutcome,
  trust: SettlementTrust = {},
): UsageSettlement {
  const settlement = settlementOfOutcome(outcome, trust);
  return settlement.state === "settled"
    ? { ...settlement, reason: "superseded" }
    : settlement;
}

/** A superseded run whose Worker never reported: the model may have been used and nobody can say how much. */
export const SUPERSEDED_NO_REPORT: UsageSettlement = {
  state: "settled",
  costMicroUsd: null,
  promptTokens: null,
  completionTokens: null,
  reason: "superseded",
};

const NO_RESULT: UsageSettlement = {
  state: "settled",
  costMicroUsd: null,
  promptTokens: null,
  completionTokens: null,
  reason: "no_result",
};

/** A usage that shows no model call: no call and no token. */
function showsNoModelCall(usage: ReportedUsage): boolean {
  return (
    usage.aiCalls === 0 &&
    usage.promptTokens === 0 &&
    usage.completionTokens === 0
  );
}

/**
 * How a reported outcome settles the record of its job. A reported usage settles it, with its cost
 * (null when unknown) and tokens, whatever the outcome: a run that failed after it used the model still cost
 * what it cost (#273), and the cost of a run with an unpriced call is unknown, never zero. Without one, a run that
 * succeeded is still a run (settled, everything unknown), and a run that failed made no model call as far as
 * anybody can tell (void: checkout, configuration, a lost lease). A failed run whose usage shows no call at all
 * (what a runner of an earlier release reports for a command that never reached the model) is void too.
 *
 * Two failed results say that a runner held the job and the model may have been used, without a usable usage, and
 * count as `no_result` (everything unknown): one whose usage was sent and cannot be read (a usage that is there is
 * evidence of a call, and for a failed run nothing else would count it), and one the runner's job loop made
 * itself for a process it had to end or that left no result (`NO_RESULT_ERROR_REASONS`). A runner of an earlier
 * release never sends the reason, and an app of an earlier release ignores it: both stay void, as before.
 */
export function settlementOfOutcome(
  outcome: JobOutcome,
  trust: SettlementTrust = {},
): UsageSettlement {
  const usage = reportedUsage(outcome.result);
  if (usage === null && !outcome.ok) {
    const reason = errorReasonOf(outcome.result);
    if (
      carriesUsage(outcome.result) ||
      (reason !== null && NO_RESULT_ERROR_REASONS.includes(reason))
    )
      return NO_RESULT;
  }
  if (usage === null)
    return outcome.ok
      ? {
          state: "settled",
          costMicroUsd: null,
          promptTokens: null,
          completionTokens: null,
        }
      : { state: "void" };
  if (!outcome.ok && showsNoModelCall(usage)) return { state: "void" };
  return {
    state: "settled",
    costMicroUsd:
      usage.costUsd === null ? null : costUsdToMicroUsd(usage.costUsd),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    ...(usage.costBasis === null || trust.subscription !== true
      ? {}
      : { costBasis: usage.costBasis }),
  };
}
