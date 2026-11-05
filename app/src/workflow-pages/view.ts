// SPDX-License-Identifier: LicenseRef-Proprietary

// What the workflow pages show of a run, made from the run as the routes give it (#873). Pure: no clock, no network. Everything in a
// step's output is data from outside the page (an agent's result, what a connector got from GitHub): this file only picks the few
// values the page shows, checks their types, and decides which of them may become a link; the components render them as text.
import { isRecord } from "../workflows/json.ts";
import { formatMoney } from "../workspace-billing/money.ts";
import type { RunView, StepView } from "../workflow-runs/service.ts";
import { githubBranchLink, githubLinkInRepository } from "./github-link.ts";

const MICRO_USD_PER_USD = 1_000_000;

/** An amount in US dollars as the billing pages write it (`$0.42`, `Less than $0.0001`). */
export function formatUsd(usd: number): string {
  return formatMoney(Math.round(usd * MICRO_USD_PER_USD));
}

/** The `owner/name` the run works on: the `repo` of its input. */
export function repositoryOfRun(
  run: Pick<RunView, "input">,
): string | undefined {
  return isRecord(run.input) && typeof run.input.repo === "string"
    ? run.input.repo
    : undefined;
}

/** How long a finished step took, or null when it did not start, did not finish, or the times do not fit together. */
export function stepDurationMs(
  step: Pick<StepView, "startedAt" | "finishedAt">,
): number | null {
  if (step.startedAt === null || step.finishedAt === null) return null;
  const start = Date.parse(step.startedAt);
  const end = Date.parse(step.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/** The share of the budget that is spent, from 0 to 1 (a run can be charged to the cent over a budget it rounded). */
export function spentShare(
  run: Pick<RunView, "budgetUsd" | "spentUsd">,
): number {
  if (run.budgetUsd <= 0) return 0;
  return Math.min(1, Math.max(0, run.spentUsd / run.budgetUsd));
}

/**
 * A step of a runner environment that no runner took: it never ran and cost nothing. The engine stores it as a cost of 0 "reported"
 * (there is no figure to estimate and no limit to charge), which would read as a measurement; the page says what happened instead.
 */
export function neverRan(
  step: Pick<StepView, "errorCode" | "costUsd">,
): boolean {
  return step.errorCode === "no_runner_available" && step.costUsd === 0;
}

/** The bases that appear in a run's steps, once each, in the order the steps first used them. A step that never ran has none. */
export function costBasesOf(
  steps: readonly Pick<StepView, "costBasis" | "errorCode" | "costUsd">[],
): NonNullable<StepView["costBasis"]>[] {
  const seen: NonNullable<StepView["costBasis"]>[] = [];
  for (const step of steps)
    if (
      step.costBasis !== null &&
      !neverRan(step) &&
      !seen.includes(step.costBasis)
    )
      seen.push(step.costBasis);
  return seen;
}

/** A code or an internal name in a text (`IMPLEMENTER_X`, `agent_start_failed`): such a text is not shown to people. */
const CODE_IN_TEXT = /[A-Z_]{4,}|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;

/** The message a failed step stored, or null when it has none or it contains a code: the sentence of the `errorCode` says it then. */
export function readableMessageOf(message: string | null): string | null {
  return message === null || message === "" || CODE_IN_TEXT.test(message)
    ? null
    : message;
}

/** The longest address of an action that is shown as text (it is not a link, and it came from outside). */
export const URL_TEXT_MAX_CHARS = 200;

/** What an action step returned that the page shows, whatever the action is. A value of another type is left out. */
export type ActionResult = {
  /** A link to GitHub: only an address of the run's own repository. */
  url?: string;
  /** The address as it was returned, when it was not safe to link: shown as text. */
  urlText?: string;
  number?: number;
  existing?: boolean;
};

export function actionResultOf(
  step: Pick<StepView, "kind" | "output">,
  repository: string | undefined,
): ActionResult | undefined {
  if (step.kind !== "action" || !isRecord(step.output)) return undefined;
  const { url, number, existing } = step.output;
  const result: ActionResult = {};
  if (typeof url === "string") {
    const link = githubLinkInRepository(url, repository);
    if (link !== undefined) result.url = link;
    else
      result.urlText =
        url.length <= URL_TEXT_MAX_CHARS
          ? url
          : `${url.slice(0, URL_TEXT_MAX_CHARS - 1)}…`;
  }
  if (typeof number === "number" && Number.isInteger(number))
    result.number = number;
  if (typeof existing === "boolean") result.existing = existing;
  return Object.keys(result).length === 0 ? undefined : result;
}

/** What an agent step returned: the branch it pushed to (a link when the repository is known), and the rest of the output as data. */
export type AgentResult = {
  branch?: string;
  branchUrl?: string;
  /** The output without the facts the page shows itself, for the collapsed JSON; undefined when there is nothing left. */
  fields?: Record<string, unknown>;
};

const SHOWN_FACTS = ["branch"] as const;

export function agentResultOf(
  step: Pick<StepView, "kind" | "output">,
  repository: string | undefined,
): AgentResult | undefined {
  if (step.kind !== "agent" || !isRecord(step.output)) return undefined;
  const result: AgentResult = {};
  const { branch } = step.output;
  if (typeof branch === "string" && branch !== "") {
    result.branch = branch;
    const link = githubBranchLink(repository, branch);
    if (link !== undefined) result.branchUrl = link;
  }
  const rest = Object.fromEntries(
    Object.entries(step.output).filter(
      ([name]) => !(SHOWN_FACTS as readonly string[]).includes(name),
    ),
  );
  if (Object.keys(rest).length > 0) result.fields = rest;
  return result.branch === undefined && result.fields === undefined
    ? undefined
    : result;
}
