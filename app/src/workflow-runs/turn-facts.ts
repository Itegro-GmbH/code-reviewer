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
import { boundAgentAsk, type AgentAsk } from "../db/agent-ask.ts";
import type {
  StoredImplementerSession,
  StoredImplementerTurn,
} from "../db/repositories/implementer-repository.ts";
import { CLAUDE_CODE_HARNESS } from "../runner-identity/harness.ts";
import { FACT_NAMES, REPOS_FACT } from "../workflows/facts.ts";
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
  /**
   * #920: the turn ended with a question instead of a result. The step waits for an answer; what the turn cost is charged now. The
   * question is the agent's text, held to its bounds again here.
   */
  | {
      ok: true;
      asked: AgentAsk;
      costMicroUsd: number;
      costBasis: CostBasis;
    }
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
  // The harness of the step's profile decides, never the basis the report names: any runner could write it into a report.
  if (ended.turn.profile?.harness !== CLAUDE_CODE_HARNESS) return null;
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

function commitShas(commits: unknown): string[] {
  return Array.isArray(commits)
    ? commits.flatMap((commit: unknown) =>
        isRecord(commit) &&
        typeof commit.sha === "string" &&
        COMMIT_SHA.test(commit.sha)
          ? [commit.sha]
          : [],
      )
    : [];
}

/** The tip of a branch when the turn ended, else where it started (the commit it started from when the agent made none), else nothing. */
function tipOf(entry: Record<string, unknown>): string {
  return typeof entry.headCommit === "string" &&
    COMMIT_SHA.test(entry.headCommit)
    ? entry.headCommit
    : typeof entry.baseCommit === "string" && COMMIT_SHA.test(entry.baseCommit)
      ? entry.baseCommit
      : "";
}

/**
 * #1092: `{{<step>.repos}}`, one entry for each repository of a turn on several, in the order of the step: the repository, its base and working
 * branch, the commits this turn made on it, its tip and whether that tip is on the remote. Read from what the runner measured; an entry that
 * is not a repository report is left out, so a report that has none gives an empty list.
 */
function repoFacts(block: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(block.repos)) return [];
  return block.repos.flatMap((entry: unknown) =>
    isRecord(entry) &&
    typeof entry.fullName === "string" &&
    typeof entry.base === "string" &&
    typeof entry.branch === "string"
      ? [
          {
            fullName: entry.fullName,
            base: entry.base,
            branch: entry.branch,
            commits: commitShas(entry.commits),
            headCommit: tipOf(entry),
            pushed: entry.pushed === true,
            ...(workingBranchRejected(entry) ? { pushRejected: true } : {}),
          },
        ]
      : [],
  );
}

/** Whether the runner reported the working branch of a repository as rejected by the remote (#1094): it is not on the remote, and says why. */
function workingBranchRejected(entry: Record<string, unknown>): boolean {
  if (entry.pushed === true || !Array.isArray(entry.branches)) return false;
  return entry.branches.some(
    (branch: unknown) =>
      isRecord(branch) &&
      branch.name === entry.branch &&
      branch.result === "rejected",
  );
}

/**
 * The facts of a turn that may push; the cost is added by the caller. A turn on several repositories (#1092) also yields `repos`, and the
 * single facts are the first repository's: its working branch (the session's own name is no git branch), its commits of this turn, its tip
 * and its push state.
 */
function pushFacts(ended: EndedTurn): Record<string, unknown> {
  const block = implementerBlock(ended.jobResult);
  if (ended.session.repos !== null) {
    const repos = repoFacts(block);
    const first = repos[0];
    return {
      branch: first?.branch ?? ended.session.repos[0]?.branch ?? "",
      commits: first?.commits ?? [],
      headCommit: first?.headCommit ?? "",
      pushed: first?.pushed === true,
      [REPOS_FACT]: repos,
    };
  }
  const commits = commitShas(block.commits);
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
  // #1177: the runner found the named branch of a `pushBranch` step on the platform although the start had seen none (it appeared in between,
  // made by somebody else): nothing was pushed to it, and the step says so with the code of the start-time refusal.
  const named = ended.session.repos?.find((entry) => entry.pushOnly === true);
  if (
    ended.jobStatus === "failed" &&
    ended.jobErrorCode === "branch_exists" &&
    named !== undefined
  )
    return {
      ok: false,
      code: "push_branch_exists",
      message: `The branch ${named.branch} appeared in the repository after the step was started, and no earlier run of this lane made it, so it is not pushed to. Name a branch that does not exist yet.`,
      detail: `status=${ended.jobStatus} error=branch_exists`,
      costMicroUsd,
      costBasis,
    };
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

  // #920: a turn that handed in no result but a question (the runner reports one only for a turn that may ask; a result wins over it).
  if (ended.turn.resultSchema !== null && ended.turn.resultValue === null) {
    const asked = boundAgentAsk(implementerBlock(ended.jobResult).agentAsk);
    if (asked !== undefined)
      return { ok: true, asked, costMicroUsd, costBasis };
  }

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
  // A step on several repositories (#1092) reserves `repos` as well; a field of that name in the schema stored with the turn is dropped too.
  const agentFields = Object.fromEntries(
    Object.entries(result).filter(
      ([name]) =>
        !FACT_NAMES.includes(name) &&
        !(ended.session.repos !== null && name === REPOS_FACT),
    ),
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
