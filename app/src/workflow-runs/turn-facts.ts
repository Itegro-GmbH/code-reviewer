// SPDX-License-Identifier: LicenseRef-Proprietary

// What an agent step yields once its turn is over (#844): the result the agent handed in, held to the schema of the step again, and the
// facts the platform measured. Pure.
//
// The finish tool's result (`implementer_turns.result_value`) is the agent's data. The runner checked it against the schema; the engine
// does not take that for granted: before any part of it goes into a template, a condition or an action, it is checked again with
// `checkResultValue` against the schema the turn was stored with. A value that fails, or is missing, is a step without a result
// (`no_result`), the same as a turn that ended without calling the tool.
//
// The facts are the platform's, not the agent's: the cost (the usage the runner reported), and, when the profile version may push, the
// branch the platform made for the turn, the commits it made, the last commit and whether the branch reached the remote. A fact name is
// never taken from the result: the validator refuses such a field, and what a stored schema might still hold is dropped.
import type {
  StoredImplementerSession,
  StoredImplementerTurn,
} from "../db/repositories/implementer-repository.ts";
import { FACT_NAMES } from "../workflows/facts.ts";
import { isRecord } from "../workflows/json.ts";
import {
  checkResultValue,
  validateResultSchema,
} from "../workflows/result-schema.ts";
import { MICRO_USD_PER_USD } from "./limits.ts";

/** USD per million tokens; what the catalog states for the model of a turn. */
export type TokenPrice = { inputPerMillion: number; outputPerMillion: number };

export type EndedTurn = {
  /** The final status of the job. */
  jobStatus: "succeeded" | "failed" | "superseded" | "cancelled";
  jobErrorCode: string | null;
  /** The job was claimed by a runner (it has a claim time). A job that ended before that never ran. */
  jobClaimed: boolean;
  /** What the runner reported, as stored. */
  jobResult: unknown;
  turn: StoredImplementerTurn;
  session: StoredImplementerSession;
  /** The catalog price of the model of the turn, when the reader found one. Only read for a turn whose cost the runner did not report. */
  price?: TokenPrice | undefined;
};

/**
 * Where the cost of a step comes from: the runner's figure, the token counts at the catalog price, the cap the turn ran under, or (#856)
 * Claude Code's own estimate at API prices for a turn on a customer device's login, which is never billed.
 */
export type CostBasis = "reported" | "estimated" | "limit" | "subscription";

export type TurnOutcome =
  | {
      ok: true;
      output: Record<string, unknown>;
      /** What the step is charged, see `CostBasis`. */
      costMicroUsd: number;
      costBasis: CostBasis;
    }
  | {
      ok: false;
      code: string;
      /** A fixed sentence, stored with the step and shown to people: no code, nothing a runner or an agent wrote. */
      message: string;
      /** What went wrong in more detail (codes included). For the log of the engine only, never stored with the step. */
      detail?: string;
      costMicroUsd: number;
      costBasis: CostBasis;
    };

/** The cost the runner reported, in micro dollars; null when it reported none or a number that is no cost. */
export function costOfResult(jobResult: unknown): number | null {
  if (!isRecord(jobResult) || !isRecord(jobResult.usage)) return null;
  const cost = jobResult.usage.costUsd;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
    return null;
  return Math.ceil(cost * MICRO_USD_PER_USD);
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * What a turn cost by its token counts at the catalog price, in micro dollars; null without both counts or a price, and null for a
 * count of nothing. Micro dollars are exactly USD per million tokens times tokens. The prompt count holds cached tokens at the full
 * input price, which is mostly above what they cost; a cache write costs more than that, so this is an estimate: the caller uses it
 * only for a turn that succeeded (every call answered) and holds it to the cap the turn ran under.
 */
export function estimateCost(
  jobResult: unknown,
  price: TokenPrice | undefined,
): number | null {
  if (price === undefined || !isRecord(jobResult) || !isRecord(jobResult.usage))
    return null;
  const prompt = tokenCount(jobResult.usage.promptTokens);
  const completion = tokenCount(jobResult.usage.completionTokens);
  if (prompt === null || completion === null) return null;
  if (prompt === 0 && completion === 0) return null;
  const micro =
    prompt * price.inputPerMillion + completion * price.outputPerMillion;
  return Number.isFinite(micro) && micro >= 0 ? Math.ceil(micro) : null;
}

/**
 * #856: the estimate, in micro dollars, of a turn that ran on the login of a customer's device, or null for any other turn. Claude
 * Code's figure at API prices (0 when it gave none) counts against the budget of the run, so a run cannot be driven past it by turns
 * that cost nothing; it is not a charge and never enters a total of billing. A turn of that harness that left no usage (stopped,
 * killed) is booked at 0 as well: there is no figure, and the cap is not what it cost.
 */
export function subscriptionCost(ended: EndedTurn): number | null {
  const usage =
    isRecord(ended.jobResult) && isRecord(ended.jobResult.usage)
      ? ended.jobResult.usage
      : null;
  if (
    usage?.costBasis !== "subscription" &&
    ended.turn.profile?.harness !== "claude-code"
  )
    return null;
  const estimate = usage?.estimatedCostUsd;
  return typeof estimate === "number" &&
    Number.isFinite(estimate) &&
    estimate >= 0
    ? Math.ceil(estimate * MICRO_USD_PER_USD)
    : 0;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

function implementerBlock(jobResult: unknown): Record<string, unknown> {
  return isRecord(jobResult) && isRecord(jobResult.implementer)
    ? jobResult.implementer
    : {};
}

/** The facts of a turn that may push; the cost is added by the caller. */
function pushFacts(ended: EndedTurn): Record<string, unknown> {
  const block = implementerBlock(ended.jobResult);
  const commits = Array.isArray(block.commits)
    ? block.commits.flatMap((commit: unknown) =>
        isRecord(commit) &&
        typeof commit.sha === "string" &&
        COMMIT_SHA.test(commit.sha)
          ? [commit.sha]
          : [],
      )
    : [];
  const head =
    typeof block.headCommit === "string" && COMMIT_SHA.test(block.headCommit)
      ? block.headCommit
      : typeof block.baseCommit === "string" &&
          COMMIT_SHA.test(block.baseCommit)
        ? block.baseCommit
        : "";
  return {
    branch: ended.session.branch,
    commits,
    headCommit: head,
    pushed: block.pushed === true,
  };
}

/**
 * #891: the codes with which a claimed job a member stopped ends when its Worker never got going: it could not be started, or it was
 * given back before it had the input of the job (the release reasons of the claim, `CLAIM_RELEASE_REASONS`, but `worker_exited`, after
 * which the turn may have run). Billing frees these; the run's budget does too.
 */
const NEVER_RAN_CODES: ReadonlySet<string> = new Set([
  "launch_failed",
  "claim_failed",
  "git_access_unavailable",
  "pull_request_unavailable",
  "price_check_failed",
  "provider_pin_check_failed",
]);

/**
 * `unknownCostMicroUsd` is the cap the turn ran under. A turn whose cost the runner did not report is charged by its token counts at
 * the catalog price (never above the cap) when both are there, and at the whole cap when not, so that a run whose cost cannot be seen
 * never spends more than its budget.
 */
export function outcomeOfTurn(
  ended: EndedTurn,
  unknownCostMicroUsd: number,
): TurnOutcome {
  // #854: a turn of a runner environment that no runner took within the deadline never ran: it is free, and the step says why.
  if (ended.jobErrorCode === "no_runner_available")
    return {
      ok: false,
      code: "no_runner_available",
      message:
        "No runner of this workspace with the labels of the environment took the turn in time. Start a runner with these labels and run the workflow again.",
      costMicroUsd: 0,
      costBasis: "reported",
    };
  // #891: a turn a member stopped that never ran (no runner took it, or its Worker could not be started) used no model: it is booked
  // at no cost, not at the cap. One that ran and reported nothing may have used it, and falls through to the cap below.
  if (
    ended.jobStatus === "cancelled" &&
    (!ended.jobClaimed ||
      (ended.jobErrorCode !== null &&
        NEVER_RAN_CODES.has(ended.jobErrorCode))) &&
    costOfResult(ended.jobResult) === null
  )
    return {
      ok: false,
      code: ended.jobErrorCode ?? "cancelled",
      message: "The agent's task was stopped because the run was cancelled.",
      detail: `status=${ended.jobStatus} error=${ended.jobErrorCode ?? "none"}`,
      costMicroUsd: 0,
      costBasis: "reported",
    };
  const onSubscription = subscriptionCost(ended);
  const reported = onSubscription ?? costOfResult(ended.jobResult);
  // Only a turn that succeeded has every call answered and counted; a failed or stopped one may have lost an open call (the
  // runner then reports no cost), so it is charged at the cap.
  const estimated =
    reported === null && ended.jobStatus === "succeeded"
      ? estimateCost(ended.jobResult, ended.price)
      : null;
  const costMicroUsd =
    reported ??
    (estimated === null
      ? unknownCostMicroUsd
      : Math.min(estimated, unknownCostMicroUsd));
  const costBasis: CostBasis =
    onSubscription !== null
      ? "subscription"
      : reported !== null
        ? "reported"
        : estimated !== null
          ? "estimated"
          : "limit";
  if (ended.jobStatus !== "succeeded")
    return {
      ok: false,
      code: ended.jobErrorCode ?? "job_failed",
      message:
        // #891: stopped by a member; what it had pushed stays on its branch.
        ended.jobErrorCode === "cancelled"
          ? "The agent's task was stopped because the run was cancelled."
          : "The agent's task ended without success.",
      detail: `status=${ended.jobStatus} error=${ended.jobErrorCode ?? "none"}`,
      costMicroUsd,
      costBasis,
    };

  let result: Record<string, unknown> = {};
  if (ended.turn.resultSchema !== null) {
    const schema = validateResultSchema(ended.turn.resultSchema).schema;
    const value = ended.turn.resultValue;
    if (schema === undefined)
      return {
        ok: false,
        code: "turn_unreadable",
        message: "The result schema stored with the turn cannot be read.",
        costMicroUsd,
        costBasis,
      };
    const problems =
      value === null
        ? ["no result"]
        : checkResultValue(schema, value).map(
            (found) => `${found.path || "/"} ${found.code}`,
          );
    if (value === null || problems.length > 0)
      return {
        ok: false,
        code: "no_result",
        message:
          value === null
            ? "The agent ended without a result."
            : "The result of the agent does not fit the schema of the step.",
        detail: problems.slice(0, 5).join(", "),
        costMicroUsd,
        costBasis,
      };
    result = value;
  }

  // A fact name is never the agent's: a profile that may not push has no `branch` fact, and a result field of that name (a stored
  // schema from before the validator refused it) must not stand in for one. So the names are taken out of the result first.
  const agentFields = Object.fromEntries(
    Object.entries(result).filter(([name]) => !FACT_NAMES.includes(name)),
  );
  const facts: Record<string, unknown> = {
    ...(ended.turn.profile?.canPush === true ? pushFacts(ended) : {}),
    costUsd: costMicroUsd / MICRO_USD_PER_USD,
  };
  return {
    ok: true,
    output: { ...agentFields, ...facts },
    costMicroUsd,
    costBasis,
  };
}
