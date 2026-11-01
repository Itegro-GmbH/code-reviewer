// SPDX-License-Identifier: LicenseRef-Proprietary

// How a run's end bills (ADR 0006, 2.6 and D7): a pure mapping from the end state of a job and its stable codes to one of
// three classes. Every terminal code of today is in a table, and a test fails when a code appears that has no class
// (`outcome.test.ts`: the job end codes, the error codes and checkout reasons of the runner contract, the release
// reasons, the reasons of a runner's loop and the settled reasons). The split follows the maintainer's decision of
// 2026-10-19 (#489, #523): a run is free only when the failure is clearly our fault, and charged in full otherwise. The
// minutes-only class is left for a run whose AI cost is unknown. No database, no clock.
import "server-only";
import type {
  KnownCheckoutReason,
  KnownRunnerErrorCode,
} from "../contracts/runner-api.ts";
import type { JobErrorCode } from "../jobs/job-types.ts";
import type { SettledReason } from "../usage/usage-records.ts";
import type { KeyMode } from "../workspaces/entitlements.ts";

/**
 * - `charged`       the AI price (our key, a known cost) and the minutes: everything that is not clearly our fault.
 * - `minutes_only`  the minutes, never the AI price: the AI cost of the run is unknown (`RunEnd.aiCostKnown`) and cannot
 *                   be priced. No code or reason has this class.
 * - `free`          nothing: the failure is clearly our fault (the VM, a crash, a timeout, our infrastructure, the managed
 *                   key).
 */
export const OUTCOME_CLASSES = ["charged", "minutes_only", "free"] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/**
 * The class of a run that failed after it used the model, with no result delivered. The maintainer decided on 2026-10-19
 * (#489) that it stays `charged`: AI and minutes.
 */
export const AI_COST_FAILURE_CLASS = "charged" as const;

/** The codes that get `AI_COST_FAILURE_CLASS`: the model was used, the run ended without a result of the review. */
export const AI_COST_FAILURE_CODES = [
  "command_failed",
  "dynamic_budget_exceeded",
  "cost_limit_reached",
  "dynamic_policy_violation",
  "llm_bad_request",
  "llm_context_length_exceeded",
  // #754: the Implementer, after its agent ran: it gave up, the repository refused the branch, the work left the branch or the
  // repository could not be committed or verified afterwards, the turn ran out of time. The model was used in each.
  "agent_gave_up",
  "push_rejected",
  "branch_violation",
  "time_limit_reached",
] as const;

/** The codes a claim ends or hands back a job with (`CLAIM_FAILURE_CODES` and `CLAIM_RELEASE_REASONS`, #553); a test compares. */
type ClaimCode =
  | "managed_model_unavailable"
  | "llm_not_configured"
  | "llm_provider_unsupported"
  | "llm_model_unavailable"
  | "provider_address_changed"
  | "job_llm_options_invalid"
  | "job_args_invalid"
  | "job_env_invalid"
  | "git_connection_disabled"
  | "git_connection_gone"
  | "git_connection_suspended"
  | "git_scope_refused"
  | "git_app_auth_failed"
  | "git_access_failed"
  | "git_access_unavailable"
  | "pull_request_unavailable"
  | "claim_failed"
  | "price_check_failed"
  | "provider_pin_check_failed";

/** The codes that arrive through the release call of a Dispatcher (`KnownReleaseReason` in the contract). */
type ReleaseReason = "launch_failed" | "worker_exited";

/**
 * Job end codes (`JOB_ERROR_CODES`), release reasons and the error codes of the runner contract. An exhaustive record:
 * a code added to one of those lists fails the typecheck here, and a code of the contract file fails the test.
 */
export const ERROR_CODE_CLASSES = {
  // The queue's own codes. A job that never ran has no minutes and no cost, so it prices to nothing whatever its class;
  // it is free only where the cause is ours.
  lease_expired: "free",
  // A timeout caused by us bills nothing (decision 1). The queue ends a job 25 minutes after the claim, the runner at 20;
  // Dynamic stops at 600 s on its own and Diff clips the diff, so a stall is never the size of the pull request.
  timeout: "free",
  // Cancelled by the customer's side (the project, the pull request, the review kind, the command): in full, which is
  // nothing while it never ran and what it used when it did.
  project_deactivated: "charged",
  pull_request_closed: "charged",
  pull_request_draft: "charged",
  review_kind_changed: "charged",
  no_capable_runner: "free",
  dynamic_review_disabled: "free",
  command_removed: "charged",
  dispatch_unavailable: "free",
  // Refused at claim by the operator's switch (`workspace_suspended`) or by the limit of the plan the operator assigned
  // (`quota_exhausted`). The job never ran, so it prices to nothing whatever its class; and no hold was taken.
  workspace_suspended: "charged",
  quota_exhausted: "charged",
  entitlements_invalid: "free",
  // Refused at claim by billing (#498): a claim refusal is free. No hold was taken (or it is released with the job).
  balance_negative: "free",
  insufficient_balance: "free",
  billing_rates_incomplete: "free",
  billing_hold_released: "free",
  // Refused at claim by the customer's monthly limit or the hidden brake (#499): free, and no hold was taken.
  monthly_limit_reached: "free",
  reviews_paused: "free",
  billing_limits_unreadable: "free",
  // The Dispatcher gave the job back.
  launch_failed: "free",
  worker_exited: "free",
  // The runner's codes. The job was refused before PR-Agent ran, or the runner itself failed: ours.
  invalid_job: "free",
  invalid_command: "free",
  pr_agent_version_mismatch: "free",
  identity_patch_failed: "free",
  runner_error: "free",
  runner_shutdown: "free",
  lease_lost: "free",
  // PR-Agent ran and handled a failure itself; the model was used (`AI_COST_FAILURE_CODES`).
  command_failed: AI_COST_FAILURE_CLASS,
  // The model worked, but nothing reached the pull request or nothing could be made of its answer: no result, and not
  // clearly our fault, so charged in full.
  review_not_published: "charged",
  llm_output_invalid: "charged",
  unknown: "charged",
  // A review that was delivered, cut to GitHub's size limit.
  review_state_truncated: "charged",
  review_text_truncated: "charged",
  // The pull request is the customer's side of the line. The Git access is not clearly ours (a revoked installation is the
  // customer's, our own App token is ours), so it is charged.
  pr_not_found: "charged",
  git_auth: "charged",
  git_forbidden: "charged",
  git_unprocessable: "charged",
  // GitHub's availability and our own use of it are not the customer's.
  git_rate_limit: "free",
  git_unavailable: "free",
  git_provider_init: "free",
  // The model provider: what the request or the customer's pull request caused is the customer's. Every other failure of
  // the provider is ours when the managed key is used (`OURS_ON_MANAGED_KEY`: the key, the account, the model, the rate
  // limit, an outage, a timeout of a call) and the customer's on their own key.
  llm_rate_limit: "charged",
  llm_unavailable: "charged",
  llm_timeout: "charged",
  llm_bad_request: AI_COST_FAILURE_CLASS,
  llm_context_length_exceeded: AI_COST_FAILURE_CLASS,
  llm_auth: "charged",
  llm_quota: "charged",
  model_unknown: "charged",
  llm_parameters_unsupported: "charged",
  // Refused or handed back at claim (#553): nothing ran, the model was not asked and no VM was kept. The codes that name the
  // customer's side of the line (a closed pull request, a missing one, the Dynamic settings) keep their class above.
  managed_model_unavailable: "free",
  llm_not_configured: "free",
  llm_provider_unsupported: "free",
  llm_model_unavailable: "free",
  provider_address_changed: "free",
  job_llm_options_invalid: "free",
  job_args_invalid: "free",
  job_env_invalid: "free",
  git_connection_disabled: "free",
  git_connection_gone: "free",
  git_connection_suspended: "free",
  git_scope_refused: "free",
  git_app_auth_failed: "free",
  git_access_failed: "free",
  git_access_unavailable: "free",
  pull_request_unavailable: "free",
  claim_failed: "free",
  price_check_failed: "free",
  provider_pin_check_failed: "free",
  // Dynamic Review.
  dynamic_engine_unavailable: "free",
  dynamic_isolation_self_check_failed: "free",
  dynamic_accounting_failed: "free",
  // Raised for missing job options, missing model prices or an invalid operator environment, before any model call: the
  // operator's side (#498, the review of #525).
  dynamic_config_invalid: "free",
  dynamic_policy_violation: AI_COST_FAILURE_CLASS,
  dynamic_budget_exceeded: AI_COST_FAILURE_CLASS,
  dynamic_model_features_unsupported: "charged",
  // A Diff Review that stopped sending model requests at the cost limit of its project (#666): it used the model, so in full,
  // like the Dynamic Review that was stopped at its budget.
  cost_limit_reached: AI_COST_FAILURE_CLASS,
  checkout_incomplete: "charged",
  // Replaced by a newer push; it reported what it used. In full.
  superseded: "charged",
  // The Implementer (#746, classes settled in #754): what ended before the agent ran is free (no model call was made); what ended
  // after it ran is charged like any run that used the model (`AI_COST_FAILURE_CODES`), none of it is clearly our fault: the
  // agent gave up, the repository refused its branch, the work left the branch (or the repository could not be committed or
  // verified afterwards: `RepositoryUnusable` reports `branch_violation`), the turn was out of time. `cost_limit_reached` is above.
  branch_exists: "free",
  base_branch_not_found: "free",
  clone_failed: "free",
  setup_failed: "free",
  git_write_not_granted: "free",
  implementer_engine_unavailable: "free",
  implementer_config_invalid: "free",
  agent_gave_up: AI_COST_FAILURE_CLASS,
  push_rejected: AI_COST_FAILURE_CLASS,
  branch_violation: AI_COST_FAILURE_CLASS,
  time_limit_reached: AI_COST_FAILURE_CLASS,
} as const satisfies Record<
  JobErrorCode | KnownRunnerErrorCode | ReleaseReason | ClaimCode,
  OutcomeClass
>;
export type ClassifiedCode = keyof typeof ERROR_CODE_CLASSES;

/** Codes that are an error on our side when the run used the operator's key, and the customer's on their own key. */
export const OURS_ON_MANAGED_KEY: readonly ClassifiedCode[] = [
  "llm_rate_limit",
  "llm_unavailable",
  "llm_timeout",
  "llm_auth",
  "llm_quota",
  "model_unknown",
  "llm_parameters_unsupported",
  "dynamic_model_features_unsupported",
];

/** Why a Dynamic Review checkout failed (`checkout_incomplete`): the finer name refines the class of the code. */
export const CHECKOUT_REASON_CLASSES = {
  // Our own request, the transport to the Git server, the isolation we could not prove.
  invalid_request: "free",
  protocol: "free",
  pack_invalid: "free",
  timeout: "free",
  transport: "free",
  isolation: "free",
  context: "free",
  // What the repository or the pull request is, and a checkout that was stopped with its run (cancelled, superseded).
  cancelled: "charged",
  ref_moved: "charged",
  ref_missing: "charged",
  object_missing: "charged",
  tree_invalid: "charged",
  entries: "charged",
  path_invalid: "charged",
  budget_transfer: "charged",
  budget_preparation: "charged",
  budget_exposed: "charged",
  diff_too_large: "charged",
  input_too_large: "charged",
} as const satisfies Record<KnownCheckoutReason, OutcomeClass>;

/**
 * The finer names the loop of a runner gives for a process it had to end (`NO_RESULT_ERROR_REASONS`): the model may have
 * been used and nobody can say how much. They add nothing to the class of the code (a run without a result is charged,
 * unless the code says it is ours); an unreadable cost is `RunEnd.aiCostKnown`.
 */
export const RESULT_REASON_CLASSES = {
  no_result_from_process: "charged",
  unreadable_usage: "charged",
} as const satisfies Record<string, OutcomeClass>;

/** Why a usage record was settled without a report of its run. */
export const SETTLED_REASON_CLASSES = {
  no_result: "charged",
  superseded: "charged",
} as const satisfies Record<SettledReason, OutcomeClass>;

/** The end of a run, as the job and its usage record state it. */
export type RunEnd = {
  /** The terminal status of the job. */
  status: "succeeded" | "failed" | "cancelled" | "superseded";
  /** `jobs.error_code`: a job end code or the code the runner reported. */
  errorCode: string | null;
  /** The finer name the runner reported next to the code (`errorReason`). */
  errorReason?: string | null;
  /** `usage_records.settled_reason`. */
  settledReason?: SettledReason | string | null;
  /** Whose key the run was made with. */
  keyMode: KeyMode;
  /**
   * False when the AI cost of the run is unknown (`usage_records.cost_micro_usd` is null): the AI part cannot be priced,
   * so a run that would be charged bills its minutes only. Left out or true, the cost is not in question.
   */
  aiCostKnown?: boolean;
};

// From the dearest to the cheapest for the customer: when several facts apply, the cheapest wins.
const RANK: Record<OutcomeClass, number> = {
  free: 0,
  minutes_only: 1,
  charged: 2,
};

function cheaper(a: OutcomeClass, b: OutcomeClass): OutcomeClass {
  return RANK[a] <= RANK[b] ? a : b;
}

function lookup<T extends string>(
  table: Record<T, OutcomeClass>,
  key: string | null | undefined,
): OutcomeClass | undefined {
  if (key === null || key === undefined) return undefined;
  return Object.hasOwn(table, key) ? table[key as T] : undefined;
}

function classOfCode(code: string | null, keyMode: KeyMode): OutcomeClass {
  // A code this build does not know (a newer runner) is not clearly our fault: charged.
  const known = lookup<ClassifiedCode>(ERROR_CODE_CLASSES, code);
  if (known === undefined) return "charged";
  if (
    keyMode === "managed" &&
    OURS_ON_MANAGED_KEY.includes(code as ClassifiedCode)
  )
    return "free";
  return known;
}

/**
 * The class of a run's end. Free only when the failure is clearly our fault, charged in full otherwise: a delivered
 * result, a failed, limited, cancelled or superseded run, a run without a result and a code this build does not know. A
 * job that never ran (cancelled or superseded while queued) is charged too, and prices to nothing: it has no minutes and
 * no cost. The code of a failure, the finer reason and the settled reason each give a class, and the cheapest for the
 * customer wins (a run that was our error and also left no result is ours). The one exception is a run whose AI cost is
 * unknown (`aiCostKnown: false`): where it would be charged, only its minutes are. Never throws.
 */
export function classifyOutcome(end: RunEnd): OutcomeClass {
  let outcome = classOfEnd(end);
  if (end.errorCode === "checkout_incomplete") {
    // A reason this build does not know (a newer runner) is not clearly our fault, like an unknown code. No reason at all
    // leaves the class of the code.
    const refined = lookup(CHECKOUT_REASON_CLASSES, end.errorReason);
    if (refined !== undefined) outcome = cheaper(outcome, refined);
  }
  const loop = lookup(RESULT_REASON_CLASSES, end.errorReason);
  if (loop !== undefined) outcome = cheaper(outcome, loop);
  const settled = lookup(SETTLED_REASON_CLASSES, end.settledReason);
  if (settled !== undefined) outcome = cheaper(outcome, settled);
  if (outcome === "charged" && end.aiCostKnown === false) return "minutes_only";
  return outcome;
}

function classOfEnd(end: RunEnd): OutcomeClass {
  if (end.status === "succeeded") return "charged";
  // Superseded by a newer push, with or without a run: in full. A job that never ran prices to nothing.
  if (end.status === "superseded" && end.errorCode === null) return "charged";
  return classOfCode(end.errorCode, end.keyMode);
}
