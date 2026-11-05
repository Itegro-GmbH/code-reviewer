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
  /** What the runner reported, as stored. */
  jobResult: unknown;
  turn: StoredImplementerTurn;
  session: StoredImplementerSession;
  /** The catalog price of the model of the turn, when the reader found one. Only read for a turn whose cost the runner did not report. */
  price?: TokenPrice | undefined;
};

/** Where the cost of a step comes from: the runner's figure, the token counts at the catalog price, or the cap the turn ran under. */
export type CostBasis = "reported" | "estimated" | "limit";

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
      message: string;
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
 * What a turn cost by its token counts at the catalog price, in micro dollars; null without both counts or a price. Micro dollars
 * are exactly USD per million tokens times tokens. The runner's count does not know cached or reasoning tokens, so this is an
 * estimate: it is held to the cap the turn ran under by the caller.
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
  const micro =
    prompt * price.inputPerMillion + completion * price.outputPerMillion;
  return Number.isFinite(micro) && micro >= 0 ? Math.ceil(micro) : null;
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
 * `unknownCostMicroUsd` is the cap the turn ran under. A turn whose cost the runner did not report is charged by its token counts at
 * the catalog price (never above the cap) when both are there, and at the whole cap when not, so that a run whose cost cannot be seen
 * never spends more than its budget.
 */
export function outcomeOfTurn(
  ended: EndedTurn,
  unknownCostMicroUsd: number,
): TurnOutcome {
  const reported = costOfResult(ended.jobResult);
  const estimated =
    reported === null ? estimateCost(ended.jobResult, ended.price) : null;
  const costMicroUsd =
    reported ??
    (estimated === null
      ? unknownCostMicroUsd
      : Math.min(estimated, unknownCostMicroUsd));
  const costBasis: CostBasis =
    reported !== null ? "reported" : estimated !== null ? "estimated" : "limit";
  if (ended.jobStatus !== "succeeded")
    return {
      ok: false,
      code: ended.jobErrorCode ?? "job_failed",
      message: `The turn ended as ${ended.jobStatus}${ended.jobErrorCode === null ? "" : ` (${ended.jobErrorCode})`}.`,
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
            : `The result does not fit the schema of the step: ${problems.slice(0, 5).join(", ")}.`,
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
