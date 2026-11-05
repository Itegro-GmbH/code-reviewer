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
// branch the platform made for the turn, the commits it made, the last commit and whether the branch reached the remote. A fact wins
// over a result field of the same name (the validator refuses such a field, so none exists).
import type {
  StoredImplementerSession,
  StoredImplementerTurn,
} from "../db/repositories/implementer-repository.ts";
import { isRecord } from "../workflows/json.ts";
import {
  checkResultValue,
  validateResultSchema,
} from "../workflows/result-schema.ts";
import { MICRO_USD_PER_USD } from "./limits.ts";

export type EndedTurn = {
  /** The final status of the job. */
  jobStatus: "succeeded" | "failed" | "superseded" | "cancelled";
  jobErrorCode: string | null;
  /** What the runner reported, as stored. */
  jobResult: unknown;
  turn: StoredImplementerTurn;
  session: StoredImplementerSession;
};

export type TurnOutcome =
  | {
      ok: true;
      output: Record<string, unknown>;
      /** What the step is charged: the cost the runner reported, or the cap of the step when it reported none. */
      costMicroUsd: number;
    }
  | {
      ok: false;
      code: string;
      message: string;
      costMicroUsd: number;
    };

/** The cost the runner reported, in micro dollars; null when it reported none or a number that is no cost. */
export function costOfResult(jobResult: unknown): number | null {
  if (!isRecord(jobResult) || !isRecord(jobResult.usage)) return null;
  const cost = jobResult.usage.costUsd;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
    return null;
  return Math.ceil(cost * MICRO_USD_PER_USD);
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
 * `unknownCostMicroUsd` is what a turn is charged whose cost the runner did not report: the cap it ran under, so that a run whose cost
 * cannot be seen never spends more than its budget.
 */
export function outcomeOfTurn(
  ended: EndedTurn,
  unknownCostMicroUsd: number,
): TurnOutcome {
  const costMicroUsd = costOfResult(ended.jobResult) ?? unknownCostMicroUsd;
  if (ended.jobStatus !== "succeeded")
    return {
      ok: false,
      code: ended.jobErrorCode ?? "job_failed",
      message: `The turn ended as ${ended.jobStatus}${ended.jobErrorCode === null ? "" : ` (${ended.jobErrorCode})`}.`,
      costMicroUsd,
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
      };
    result = value;
  }

  const facts: Record<string, unknown> = {
    ...(ended.turn.profile?.canPush === true ? pushFacts(ended) : {}),
    costUsd: costMicroUsd / MICRO_USD_PER_USD,
  };
  return { ok: true, output: { ...result, ...facts }, costMicroUsd };
}
