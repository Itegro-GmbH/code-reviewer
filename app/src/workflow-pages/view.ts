// SPDX-License-Identifier: LicenseRef-Proprietary

// What the workflow pages show of a run, made from the run as the routes give it (#873). Pure: no clock, no network. Everything in a
// step's output is data from outside the page (an agent's result, what a connector got from GitHub): this file only picks the few
// values the page shows, checks their types, and decides which of them may become a link; the components render them as text.
import { isRecord } from "../workflows/json.ts";
import { formatUtc } from "../ui/format-time.ts";
import { formatMoney } from "../workspace-billing/money.ts";
import type { RunView, StepView } from "../workflow-runs/service.ts";
import { githubBranchLink, githubLinkInRepository } from "./github-link.ts";

const MICRO_USD_PER_USD = 1_000_000;

/** An amount in US dollars as the billing pages write it (`$0.42`, `Less than $0.0001`). */
export function formatUsd(usd: number): string {
  return formatMoney(Math.round(usd * MICRO_USD_PER_USD));
}

/**
 * The `owner/name` the run works on: the `ticket.repo.fullName` of a run with a ticket (#916), the `repo` of the input of a run by hand
 * (written since #916 as `{ input }`, before as the input itself), the `repo.fullName` of a run a label started.
 */
export function repositoryOfRun(
  run: Pick<RunView, "input">,
): string | undefined {
  if (!isRecord(run.input)) return undefined;
  const { ticket, input } = run.input;
  if (isRecord(ticket) && isRecord(ticket.repo)) {
    const { fullName } = ticket.repo;
    if (typeof fullName === "string") return fullName;
  }
  const { repo } = isRecord(input) ? input : run.input;
  if (typeof repo === "string") return repo;
  return isRecord(repo) && typeof repo.fullName === "string"
    ? repo.fullName
    : undefined;
}

/** The ticket a run is about, as the run stored it (`ticket.ts`): everything is text from whoever opened it. */
export type RunTicket = {
  /** How the ticket is called: `#15` for a GitHub issue, `PROJ-123` for a Jira one. */
  ref: string;
  title?: string;
  /** A link to GitHub, only to an address of the run's own repository. */
  url?: string;
};

/** The ticket of a run that has one (a `ticket` in its input, #916), or undefined. The address is linked through `github-link.ts` only. */
export function ticketOfRun(
  run: Pick<RunView, "input">,
  repository: string | undefined,
): RunTicket | undefined {
  if (!isRecord(run.input) || !isRecord(run.input.ticket)) return undefined;
  const { key, number, title, url } = run.input.ticket;
  const name =
    typeof key === "string" && key !== ""
      ? key
      : typeof number === "number" && Number.isInteger(number) && number > 0
        ? String(number)
        : undefined;
  if (name === undefined) return undefined;
  const link = githubLinkInRepository(url, repository);
  return {
    ref: /^\d+$/.test(name) ? `#${name}` : name,
    ...(typeof title === "string" && title !== "" ? { title } : {}),
    ...(link === undefined ? {} : { url: link }),
  };
}

/** How long a run took, or null while it runs or when the times do not fit together. */
export function runDurationMs(
  run: Pick<RunView, "createdAt" | "finishedAt">,
): number | null {
  return stepDurationMs({
    startedAt: run.createdAt,
    finishedAt: run.finishedAt,
  });
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
export type PullRequestResult = {
  fullName: string;
  base: string;
  head: string;
  state: "opened" | "existing" | "skipped";
  /** Why a skipped one got none: direct work, nothing pushed, no commits ahead of the base. */
  reason?: "direct" | "not_pushed" | "no_commits";
  number?: number;
  /** A link to the pull request, only when it is an address of that repository. */
  url?: string;
};

export type ActionResult = {
  /** #1094: one entry per repository of a pull request step with several repositories. */
  pullRequests?: PullRequestResult[];
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
  const pullRequests = pullRequestsOf(step.output.pullRequests);
  if (pullRequests.length > 0) result.pullRequests = pullRequests;
  return Object.keys(result).length === 0 ? undefined : result;
}

const FULL_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PULL_REQUESTS_SHOWN_MAX = 10;
const BRANCH_TEXT_MAX_CHARS = 255;

function shortText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** The pull requests of a step with several repositories (#1094): each one checked, an entry that is not what the connector yields is left out. */
function pullRequestsOf(value: unknown): PullRequestResult[] {
  if (!Array.isArray(value)) return [];
  const found: PullRequestResult[] = [];
  for (const entry of value.slice(0, PULL_REQUESTS_SHOWN_MAX)) {
    if (!isRecord(entry)) continue;
    const { fullName, state, reason, number, url } = entry;
    const base = shortText(entry.base, BRANCH_TEXT_MAX_CHARS);
    const head = shortText(entry.head, BRANCH_TEXT_MAX_CHARS);
    if (
      typeof fullName !== "string" ||
      !FULL_NAME.test(fullName) ||
      base === undefined ||
      head === undefined ||
      (state !== "opened" && state !== "existing" && state !== "skipped")
    )
      continue;
    const result: PullRequestResult = { fullName, base, head, state };
    if (
      reason === "direct" ||
      reason === "not_pushed" ||
      reason === "no_commits"
    )
      result.reason = reason;
    if (typeof number === "number" && Number.isInteger(number))
      result.number = number;
    // The link is the pull request's own address in the repository the entry names, never one of the run's repository.
    const link = githubLinkInRepository(url, fullName);
    if (link !== undefined) result.url = link;
    found.push(result);
  }
  return found;
}

/** What a condition or a loop decided, as the engine wrote it into the step: the branch it took, or how a loop ended and after how many rounds. */
export type ControlResult = {
  taken?: "then" | "else";
  exit?: "until" | "maxRounds" | "budget";
  rounds?: number;
};

export function controlResultOf(
  step: Pick<StepView, "kind" | "output">,
): ControlResult | undefined {
  if ((step.kind !== "if" && step.kind !== "loop") || !isRecord(step.output))
    return undefined;
  const { taken, exit, rounds } = step.output;
  const result: ControlResult = {};
  if (taken === "then" || taken === "else") result.taken = taken;
  if (exit === "until" || exit === "maxRounds" || exit === "budget")
    result.exit = exit;
  if (typeof rounds === "number" && Number.isInteger(rounds))
    result.rounds = rounds;
  return Object.keys(result).length === 0 ? undefined : result;
}

/** What an agent step returned: the branch it pushed to (a link when the repository is known), and the rest of the output as data. */
/** One repository of an agent step with several (#1094): the entry of `{{<step>.repos}}`. */
export type AgentRepoResult = {
  fullName: string;
  base: string;
  branch: string;
  /** A link to the branch in that repository, when it is on the remote. */
  branchUrl?: string;
  commits: number;
  pushed: boolean;
};

export type AgentResult = {
  /** #1094: one entry per repository, in the order of the step; the single `branch` is then not shown (it is the first entry). */
  repos?: AgentRepoResult[];
  /** What the agent said it did, as the text it is (the `summary` of its result). */
  summary?: string;
  branch?: string;
  branchUrl?: string;
  /** The output without the facts the page shows itself, for the collapsed JSON; undefined when there is nothing left. */
  fields?: Record<string, unknown>;
};

const SHOWN_FACTS = ["branch", "repos"] as const;

/** The repositories of an agent step with several (#1094), as the engine stored them; an entry that is not what the fact says is left out. */
function agentReposOf(value: unknown): AgentRepoResult[] {
  if (!Array.isArray(value)) return [];
  const found: AgentRepoResult[] = [];
  for (const entry of value.slice(0, PULL_REQUESTS_SHOWN_MAX)) {
    if (!isRecord(entry)) continue;
    const base = shortText(entry.base, BRANCH_TEXT_MAX_CHARS);
    const branch = shortText(entry.branch, BRANCH_TEXT_MAX_CHARS);
    if (
      typeof entry.fullName !== "string" ||
      !FULL_NAME.test(entry.fullName) ||
      base === undefined ||
      branch === undefined
    )
      continue;
    const link =
      entry.pushed === true && branch === entry.branch
        ? githubBranchLink(entry.fullName, entry.branch)
        : undefined;
    found.push({
      fullName: entry.fullName,
      base,
      branch,
      ...(link === undefined ? {} : { branchUrl: link }),
      commits: Array.isArray(entry.commits) ? entry.commits.length : 0,
      pushed: entry.pushed === true,
    });
  }
  return found;
}

export function agentResultOf(
  step: Pick<StepView, "kind" | "output">,
  repository: string | undefined,
): AgentResult | undefined {
  if (step.kind !== "agent" || !isRecord(step.output)) return undefined;
  const result: AgentResult = {};
  const { branch, summary } = step.output;
  if (typeof summary === "string" && summary.trim() !== "")
    result.summary = summary;
  const repos = agentReposOf(step.output.repos);
  if (repos.length > 0) result.repos = repos;
  // With several repositories the list says it all: the single branch is the first entry's.
  if (repos.length === 0 && typeof branch === "string" && branch !== "") {
    result.branch = branch;
    const link = githubBranchLink(repository, branch);
    if (link !== undefined) result.branchUrl = link;
  }
  const rest = Object.fromEntries(
    Object.entries(step.output).filter(
      ([name]) =>
        !(SHOWN_FACTS as readonly string[]).includes(name) &&
        !(name === "summary" && result.summary !== undefined),
    ),
  );
  if (Object.keys(rest).length > 0) result.fields = rest;
  return Object.keys(result).length === 0 ? undefined : result;
}

/**
 * How long ago a time was, against a clock the caller hands in (the server's time of answering, so the page the server rendered and the
 * browser say the same): "just now", "12 min ago", "3 h ago", "2 d ago", and the date once it is over a week. A time that cannot be read
 * is "unknown time".
 */
export function formatRelativeTime(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(then) || Number.isNaN(now)) return "unknown time";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(Math.max(1, minutes))} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${String(days)} d ago`;
  return formatUtc(iso);
}

/**
 * How long a lane run took, or has been going: from its start to its end, or to `nowIso` while it is active (running or waiting for an
 * answer). Null for a run that ended without an end time, and for times that cannot be read.
 */
export function laneRunDurationMs(
  run: { status: string; createdAt: string; finishedAt: string | null },
  nowIso: string,
): number | null {
  const start = Date.parse(run.createdAt);
  if (Number.isNaN(start)) return null;
  const active = run.status === "running" || run.status === "waiting";
  const end = Date.parse(run.finishedAt ?? (active ? nowIso : ""));
  if (Number.isNaN(end) || end < start) return null;
  return end - start;
}
