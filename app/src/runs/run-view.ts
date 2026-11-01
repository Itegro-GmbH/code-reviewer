// SPDX-License-Identifier: LicenseRef-Proprietary

// What the pages and the polling endpoint know about a run: plain data worked out from a stored job.
// This is the boundary between the database row and the browser. Only fields listed here leave the
// server: the lease token, the runner id, the delivery id, the heartbeat and the lease times are not
// among them, and of the stored result only the comment link and the log tail are read. Everything
// that came from outside (the question of an `/ask`, a login, the log of the runner) is data and is
// rendered as text; the one link made from stored data is checked here.
import { maskProvidersInText } from "../llm/provider-mask.ts";
import type { JsonValue, StoredReviewCommand } from "../integrations/types.ts";
import { checkCallTrace } from "../runner-api/call-trace.ts";
import {
  IMPLEMENTER_FILE_STATUSES,
  IMPLEMENTER_RESULT_LIMITS,
  STOPPED_EARLY_REASONS,
  type ImplementerFileStatus,
  type RunnerCallTrace,
  type StoppedEarly,
} from "../runner-api/contract.ts";
import type { JobStatus } from "../db/job-status.ts";
import type { Job, JobTriggerKind } from "../jobs/job-types.ts";
import type { JobKind } from "../job-kind/job-kind.ts";
import {
  describeCheckoutReason,
  describeErrorCode,
  describeTurnErrorCode,
  type ErrorDescription,
  type ReasonDescription,
} from "./error-copy.ts";
import type { ProductIdentity } from "../product-identity/identity.ts";
import { runDurationMs } from "./run-duration.ts";
import type { RunPriceView } from "../workspace-billing/view.ts";

/** The most characters of a log the detail page shows (the runner's own limit). */
export const MAX_LOG_CHARS = 8192;

export type RunRowView = {
  id: string;
  repositoryId: string;
  /** The `owner/name` of the repository (a text from GitHub, rendered as text). */
  project: string;
  prNumber: number;
  /** The link to the pull request when it is an `https://github.com/` address, otherwise null. */
  prUrl: string | null;
  command: StoredReviewCommand;
  /** The review kind the run was queued for (#200): Diff Review or Dynamic Review. */
  reviewKind: JobKind;
  triggerKind: JobTriggerKind;
  /** "Automatic", "Comment by octocat" or "Started by octocat". */
  trigger: string;
  status: JobStatus;
  createdAt: string;
  /** When a runner took the run; null while it waits (and for a run that never started). */
  startedAt: string | null;
  finishedAt: string | null;
  /** From start to end, or to the time of this answer for a running run; null when it has not started. */
  durationMs: number | null;
  /** One sentence for a run that did not succeed, or null. */
  problem: string | null;
  /**
   * What the review cost (#505): the final AI and infrastructure price, or "not charged". Present only while billing is on and the
   * review was billed; absent otherwise (billing off, a review still open, a review claimed with billing off).
   */
  price?: RunPriceView;
  /**
   * Present only for a run of the Implementer (#758), which is a repository and a branch, not a pull request: `prNumber` is a
   * placeholder then and `prUrl` null. Absent for every other kind, so their views are what they were.
   */
  implementer?: ImplementerRowView;
};

/** What the list knows of a task: its branch (a text from the task, rendered as text) and a link to it when it can be made. */
export type ImplementerRowView = {
  /** The new branch of the task; null when the turn of the job cannot be read. */
  branch: string | null;
  /** `<repository url>/tree/<branch>` for the repository's own https url on github.com, otherwise null. */
  branchUrl: string | null;
};

/** One commit of a task, as the run shows it. */
export type ImplementerCommitView = {
  shortSha: string;
  /** The first line of the message, cleaned and cut. Untrusted text. */
  subject: string;
  /** The link to the commit on GitHub; null while it was not pushed. */
  url: string | null;
};

export type ImplementerFileView = {
  /** Cleaned and cut. Untrusted text. */
  path: string;
  status: ImplementerFileStatus;
};

/** What the detail page shows of a task besides the facts every run has. Built only from the fields listed here. */
export type ImplementerDetailView = ImplementerRowView & {
  /** The branch the new one started from; null when the turn of the job cannot be read. Untrusted text. */
  baseBranch: string | null;
  /** The task given to the agent: the first characters, and the whole text when there is more. Untrusted text. */
  instruction: { preview: string; full: string | null };
  /** The agent's own account of what it did; null while there is none. Untrusted text, rendered as text. */
  summary: string | null;
  commits: { shown: ImplementerCommitView[]; more: number };
  files: { count: number; shown: ImplementerFileView[]; more: number };
  /** The last commit on the branch after the turn, when the turn pushed. */
  head: { shortSha: string; url: string | null } | null;
  /** For a task that did not succeed but pushed work: "N commits were pushed to <branch>."; null otherwise. */
  pushedNote: string | null;
  /**
   * The result carried the agent's report (commits, files, summary). False for a task that ended without one (a lost lease, a
   * runner that died): then an empty list means "not known", not "none", and the page sends the reader to the branch.
   */
  reported: boolean;
};

/** What the repository knows of the turn of a job, for the row (`runs-repository.ts`). */
export type ImplementerRowSource = {
  branch: string;
  /** The url of the repository as the repositories table holds it. */
  repositoryUrl: string;
};

/** And for the detail. */
export type ImplementerDetailSource = ImplementerRowSource & {
  baseBranch: string;
  instruction: string;
};

/**
 * What a run consumed, as far as the runner reported it: only these four numbers and the model name
 * leave the server, never the rest of the stored `usage` (prompt and completion split, fallback flag).
 */
export type RunUsageView = {
  /** The model that answered, or null when the runner could not name it. A text from outside. */
  model: string | null;
  /** All tokens the run's calls used, summed. */
  totalTokens: number;
  /** How many model calls the run made. */
  aiCalls: number;
  /** The cost in US dollars; null when it is not known (a Dynamic Review never guesses it). */
  costUsd: number | null;
  /** Why a Dynamic Review was wrapped up early and may be incomplete (#293); null otherwise. */
  stoppedEarly: StoppedEarly | null;
};

export type RunDetailView = RunRowView & {
  headSha: string;
  /** The question of an `/ask`, or an empty string. Untrusted text. */
  args: string;
  /** Attempts lost to a lapsed lease or a given back claim. */
  attempts: number;
  errorCode: string | null;
  /** Whether the error code has a sentence of its own (an unknown one is shown with the general text). */
  errorCodeKnown: boolean;
  /** Why a Dynamic Review checkout failed, in words; null when the run has no reason (or none that is shaped like one). */
  errorReason: ReasonDescription | null;
  /** Only an `https://github.com/` address; null when the run has no comment or the address is not one. */
  commentUrl: string | null;
  /** The run succeeded but the runner could not find the comment it wrote. */
  commentMissing: boolean;
  log: { text: string; truncated: boolean };
  /** The newer run that replaced this one, for a replaced run. */
  supersededBy: string | null;
  /** The usage the runner reported, or null (a run that never reached a model, or an older result). */
  usage: RunUsageView | null;
  /**
   * What each model call and tool call of a Dynamic Review was (#541), without content: numbers and stable names.
   * Null for a run without one (an older runner, a Diff Review, a run that made no call). On a managed quality
   * level the cost of a call is null, like the cost of the run.
   */
  callTrace: RunnerCallTrace | null;
  /**
   * The run was on a managed quality level (#283): its cost is not shown (`usage.costUsd` is null). With the tokens it
   * would give a price per token, which tells the model; the operator reads the cost through the operator API.
   */
  costHidden: boolean;
  /** The task of a run of the Implementer (#758); absent for every other kind. */
  implementer?: ImplementerDetailView;
};

/** What the list can be narrowed by: one repository, one status. */
export type RunsFilter = { repositoryId?: string; status?: JobStatus };

export type RunsSnapshot = {
  /** When the answer was made; the duration of a running run is counted up to it. */
  generatedAt: string;
  runs: RunRowView[];
  /** More runs exist than are listed. */
  limited: boolean;
};

/**
 * One run as a member of the workspace sees it (#657): the facts and the review that was posted, without the log and the
 * call trace, which only the admin portal shows (`RunDetailView`). Neither leaves the server for a customer.
 */
export type CustomerRunDetailView = Omit<RunDetailView, "log" | "callTrace"> & {
  /**
   * The text of the review comment the run posted on GitHub (the Findings), cleaned like the log; null when none was kept
   * (a run that posted nothing, a comment that could not be read, a run from before the text was kept). Untrusted text.
   */
  reviewText: string | null;
};

export type RunDetailSnapshot = {
  generatedAt: string;
  run: CustomerRunDetailView;
};

/**
 * A link to GitHub, only when it points to github.com over https (no other host, no credentials, no
 * port). Anything else, including a `javascript:` address, is no link: the comment of a run is written
 * by the runner and the pull request address comes with a delivery, and neither may take a person
 * anywhere else. Used for both links of a run.
 */
export function safeGithubUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048)
    return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const ok =
    parsed.protocol === "https:" &&
    parsed.hostname === "github.com" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "";
  return ok ? parsed.href : null;
}

// Escape sequences of a terminal: colors and cursor moves (CSI), and window titles or links (OSC).
const ANSI_SEQUENCES =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// Control characters other than tab and line feed, and the characters that reorder text on screen.
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * Makes a runner's log fit for showing: terminal escapes and control characters out, line breaks
 * unified. The result is still only ever rendered as text.
 */
export function cleanLog(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(ANSI_SEQUENCES, "")
    .replace(UNSAFE_CHARACTERS, "");
}

// Characters with no width or only a direction: zero-width space, joiners and marks (U+200B-U+200F), the Arabic letter mark,
// word joiners and invisible operators (U+2060-U+2064), the Mongolian vowel separator and the byte order mark. `cleanLog` keeps
// them (a review or a log may use them); the text of a task is shown beside names and links, where they would hide a difference.
const INVISIBLE_CHARACTERS = /[\u200b-\u200f\u061c\u2060-\u2064\u180e\ufeff]/g;

/** `cleanLog` and, for the text of a task, without the invisible characters. */
function cleanTaskText(raw: string): string {
  return cleanLog(raw).replace(INVISIBLE_CHARACTERS, "");
}

/** One line of the text of a task: `cleanTaskText`, then every run of white space as one space. */
function cleanTaskLine(raw: string): string {
  return cleanTaskText(raw).replace(/\s+/g, " ").trim();
}

/** The first `max` UTF-16 units of `text`: bounds the work of the cleaners on a text of any size. */
function head(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The address of a repository on GitHub without anything after it, from the url the repositories table holds; null for anything
 * that is not `https://github.com/<owner>/<name>` (no other host, port, credentials, query or fragment). The links of a task
 * are made from this and from nothing the task, the agent or the job row wrote.
 */
function githubRepositoryBase(url: string): string | null {
  const safe = safeGithubUrl(url);
  if (safe === null) return null;
  const parsed = new URL(safe);
  if (parsed.search !== "" || parsed.hash !== "") return null;
  const match = /^\/([^/]+)\/([^/]+?)\/?$/.exec(parsed.pathname);
  return match === null ? null : `https://github.com/${match[1]}/${match[2]}`;
}

/**
 * The link to a branch of a repository: its own https url on github.com plus `/tree/` plus the name with every part encoded. A name
 * with an empty part, a `.` or a `..` would leave the tree path once the browser resolves it, so it gets no link.
 */
export function githubBranchUrl(
  repositoryUrl: string,
  branch: string,
): string | null {
  const base = githubRepositoryBase(repositoryUrl);
  if (base === null) return null;
  const parts = branch.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    return null;
  try {
    return `${base}/tree/${parts.map(encodeURIComponent).join("/")}`;
  } catch {
    // A lone surrogate cannot be encoded.
    return null;
  }
}

/** The link to a commit of a repository; null for a sha that is not 40 hexadecimal characters. */
export function githubCommitUrl(
  repositoryUrl: string,
  sha: string,
): string | null {
  const base = githubRepositoryBase(repositoryUrl);
  return base === null || !COMMIT_SHA.test(sha)
    ? null
    : `${base}/commit/${sha}`;
}

const COMMIT_SHA = /^[0-9a-fA-F]{40}$/;
const SHORT_SHA_CHARS = 7;

/** How much of a task the detail page lists before it says "and N more" or shows an expander. */
const MAX_LISTED_COMMITS = 20;
const MAX_LISTED_FILES = 20;
const INSTRUCTION_PREVIEW_CHARS = 500;
/** The most characters of an instruction the page can hold (the submit's own limit). */
const MAX_INSTRUCTION_CHARS = 20_000;
const MAX_SUBJECT_CHARS = 500;
const MAX_PATH_CHARS = 300;

type StoredImplementerResult = {
  /** The result carries an `implementer` block at all: a result without one says nothing of the work, and is not "no work". */
  reported: boolean;
  headCommit: string | null;
  pushed: boolean;
  commits: { sha: string; subject: string }[];
  files: { path: string; status: ImplementerFileStatus }[];
  summary: string | null;
};

const EMPTY_IMPLEMENTER_RESULT: StoredImplementerResult = {
  reported: false,
  headCommit: null,
  pushed: false,
  commits: [],
  files: [],
  summary: null,
};

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The block of a turn in a stored result, or an empty one. The runner API checks it when it is stored; what is read here is
 * checked again, field by field, because the row may be older than the check: an entry that is not what the contract says is
 * left out. The OpenCode session and the base commit are not read: they stay on the server.
 */
function readStoredImplementer(
  result: JsonValue | null,
): StoredImplementerResult {
  if (!isRecord(result) || !isRecord(result.implementer))
    return EMPTY_IMPLEMENTER_RESULT;
  const block = result.implementer;
  const commits: StoredImplementerResult["commits"] = [];
  if (Array.isArray(block.commits))
    for (const entry of block.commits.slice(
      0,
      IMPLEMENTER_RESULT_LIMITS.commits,
    )) {
      if (
        isRecord(entry) &&
        typeof entry.sha === "string" &&
        COMMIT_SHA.test(entry.sha) &&
        typeof entry.subject === "string"
      )
        commits.push({ sha: entry.sha, subject: entry.subject });
    }
  const files: StoredImplementerResult["files"] = [];
  if (Array.isArray(block.filesChanged))
    for (const entry of block.filesChanged.slice(
      0,
      IMPLEMENTER_RESULT_LIMITS.filesChanged,
    )) {
      if (
        isRecord(entry) &&
        typeof entry.path === "string" &&
        typeof entry.status === "string" &&
        (IMPLEMENTER_FILE_STATUSES as readonly string[]).includes(entry.status)
      )
        files.push({
          path: entry.path,
          status: entry.status as ImplementerFileStatus,
        });
    }
  return {
    reported: true,
    headCommit:
      typeof block.headCommit === "string" && COMMIT_SHA.test(block.headCommit)
        ? block.headCommit
        : null,
    pushed: block.pushed === true,
    commits,
    files,
    summary: typeof block.summary === "string" ? block.summary : null,
  };
}

/**
 * The branch of a task. The name is a text from the person who started it: for display it is cleaned and given to `display`
 * (redaction, and on the operator's key the provider mask); the link is made from the raw name, encoded.
 */
function implementerRowView(
  source: ImplementerRowSource | null,
  display: (text: string) => string,
): ImplementerRowView {
  if (source === null) return { branch: null, branchUrl: null };
  return {
    branch: display(cleanTaskLine(head(source.branch, 1000))),
    branchUrl: githubBranchUrl(source.repositoryUrl, source.branch),
  };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The task of a run for the detail page (#758). Everything that came from the task, the commits and the agent is cleaned like the
 * log, stripped of known secrets, cut to the limits of the contract and rendered as text by the page; a link is made only by
 * `githubBranchUrl` and `githubCommitUrl`.
 */
function implementerDetailView(
  job: Job,
  source: ImplementerDetailSource | null,
  redact: (text: string) => string,
  onManagedKey: boolean,
): ImplementerDetailView {
  const stored = readStoredImplementer(job.result);
  // Text on the operator's key never names a provider (like the log and the review comment).
  const display = (cleaned: string): string => {
    const redacted = redact(cleaned);
    return onManagedKey ? maskProvidersInText(redacted) : redacted;
  };
  const row = implementerRowView(source, display);
  const repositoryUrl = source?.repositoryUrl ?? "";
  const agentText = (text: string, max: number, line: boolean): string =>
    cutCharacters(
      display(line ? cleanTaskLine(text) : cleanTaskText(text)),
      max,
    );
  const instruction =
    source === null
      ? ""
      : cutCharacters(
          redact(
            cleanTaskText(head(source.instruction, MAX_INSTRUCTION_CHARS * 4)),
          ),
          MAX_INSTRUCTION_CHARS,
        );
  const commits = stored.commits.map((commit): ImplementerCommitView => ({
    shortSha: commit.sha.slice(0, SHORT_SHA_CHARS),
    subject: agentText(
      head(commit.subject, MAX_SUBJECT_CHARS * 4),
      MAX_SUBJECT_CHARS,
      true,
    ),
    url: stored.pushed ? githubCommitUrl(repositoryUrl, commit.sha) : null,
  }));
  const files = stored.files.map((file): ImplementerFileView => ({
    path: agentText(head(file.path, MAX_PATH_CHARS * 4), MAX_PATH_CHARS, true),
    status: file.status,
  }));
  const summary =
    stored.summary === null
      ? ""
      : agentText(
          head(stored.summary, IMPLEMENTER_RESULT_LIMITS.summaryChars * 4),
          IMPLEMENTER_RESULT_LIMITS.summaryChars,
          false,
        ).trim();
  const pushedHead =
    stored.pushed && stored.headCommit !== null ? stored.headCommit : null;
  const failed = job.status === "failed" || job.status === "cancelled";
  const pushedWork =
    stored.pushed && (commits.length > 0 || pushedHead !== null);
  return {
    ...row,
    reported: stored.reported,
    baseBranch:
      source === null
        ? null
        : display(cleanTaskLine(head(source.baseBranch, 1000))),
    instruction: {
      preview: cutCharacters(instruction, INSTRUCTION_PREVIEW_CHARS),
      full:
        Array.from(instruction).length > INSTRUCTION_PREVIEW_CHARS
          ? instruction
          : null,
    },
    summary: summary === "" ? null : summary,
    commits: {
      shown: commits.slice(0, MAX_LISTED_COMMITS),
      more: Math.max(0, commits.length - MAX_LISTED_COMMITS),
    },
    files: {
      count: files.length,
      shown: files.slice(0, MAX_LISTED_FILES),
      more: Math.max(0, files.length - MAX_LISTED_FILES),
    },
    head:
      pushedHead === null
        ? null
        : {
            shortSha: pushedHead.slice(0, SHORT_SHA_CHARS),
            url: githubCommitUrl(repositoryUrl, pushedHead),
          },
    pushedNote:
      failed && pushedWork && row.branch !== null
        ? commits.length === 0
          ? `Work was pushed to ${row.branch}.`
          : `${String(commits.length)} ${plural(commits.length, "commit was", "commits were")} pushed to ${row.branch}.`
        : null,
  };
}

/** The sentence for the error code of a run: a task has sentences of its own where those of a review do not fit. */
function describeRunError(
  product: ProductIdentity,
  kind: JobKind,
  code: string,
  stoppedEarly: StoppedEarly | null,
): ErrorDescription {
  return kind === "implementer"
    ? describeTurnErrorCode(product, code)
    : describeErrorCode(product, code, stoppedEarly);
}

type StoredResult = {
  commentUrl: string | null;
  logTail: string;
  logTruncated: boolean;
  errorReason: string | null;
};

/** Reads the four fields the pages use from the stored result; everything else stays on the server. */
export function readStoredResult(result: JsonValue | null): StoredResult {
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return {
      commentUrl: null,
      logTail: "",
      logTruncated: false,
      errorReason: null,
    };
  return {
    commentUrl:
      typeof result.commentUrl === "string" ? result.commentUrl : null,
    logTail: typeof result.logTail === "string" ? result.logTail : "",
    logTruncated: result.logTruncated === true,
    errorReason:
      typeof result.errorReason === "string" ? result.errorReason : null,
  };
}

/** The longest model name the runner API accepts (`RunnerUsage.model`). */
const MAX_MODEL_CHARS = 200;

/** The first `max` characters of `text`, never a half of a surrogate pair. */
function cutCharacters(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : characters.slice(0, max).join("");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The model, the summed tokens, the call count and the cost of a stored result, or null when the
 * result has no usage or a field of it is not what the runner API promises. Nothing else of the usage
 * is copied. The model name is cleaned like the log: it came from the runner.
 */
export function readStoredUsage(result: JsonValue | null): RunUsageView | null {
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return null;
  const usage = result.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage))
    return null;
  const { model, totalTokens, aiCalls, costUsd } = usage;
  if (!isCount(totalTokens) || !isCount(aiCalls)) return null;
  const costKnown =
    typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0;
  if (costUsd !== null && !costKnown) return null;
  return {
    model:
      typeof model === "string"
        ? cutCharacters(cleanLog(model), MAX_MODEL_CHARS)
        : null,
    totalTokens,
    aiCalls,
    costUsd: costKnown ? costUsd : null,
    stoppedEarly:
      typeof usage.stoppedEarly === "string" &&
      (STOPPED_EARLY_REASONS as readonly string[]).includes(usage.stoppedEarly)
        ? (usage.stoppedEarly as StoppedEarly)
        : null,
  };
}

/**
 * The per-call trace of a stored result (#541), or null when the result has none or what it holds is not the
 * contract's shape (the same check the runner API applies when it is stored). It holds only numbers and stable
 * names, so there is nothing to clean.
 */
export function readStoredCallTrace(
  result: JsonValue | null,
): RunnerCallTrace | null {
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return null;
  const usage = result.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage))
    return null;
  return checkCallTrace(usage.callTrace) ?? null;
}

/**
 * Failed runs whose review is on the pull request all the same: the runner shortened it to fit
 * GitHub's comment limit and reports it as a failure, with the link to the comment it posted.
 */
const POSTED_REVIEW_ERROR_CODES: readonly string[] = [
  "review_state_truncated",
  "review_text_truncated",
];

function describeTrigger(kind: JobTriggerKind, actor: string): string {
  switch (kind) {
    case "webhook":
      return "Automatic";
    case "comment":
      return `Comment by ${actor}`;
    case "manual":
      return `Started by ${actor}`;
  }
}

/** The fields of a job the list needs; the list is read without the result, the lease or the arguments. */
export type RunRowSource = Pick<
  Job,
  | "id"
  | "repositoryId"
  | "prNumber"
  | "prUrl"
  | "command"
  | "reviewKind"
  | "triggerKind"
  | "actorLogin"
  | "status"
  | "createdAt"
  | "claimedAt"
  | "finishedAt"
  | "errorCode"
>;

function problemOf(product: ProductIdentity, job: RunRowSource): string | null {
  if (job.status === "failed" || job.status === "cancelled") {
    return job.errorCode === null
      ? job.status === "failed"
        ? "The run failed without saying why."
        : null
      : describeRunError(product, job.reviewKind, job.errorCode, null).text;
  }
  return null;
}

export function toRunRowView(
  product: ProductIdentity,
  job: RunRowSource,
  project: string,
  now: Date,
  /** What the repository knows of the turn of a run of the Implementer (#758); ignored for every other kind. */
  implementer: ImplementerRowSource | null = null,
  /** Takes known secrets out of the branch of a task before it is shown. */
  redact: (text: string) => string = (text) => text,
): RunRowView {
  const startedAt = job.claimedAt;
  return {
    id: job.id,
    repositoryId: job.repositoryId,
    project,
    prNumber: job.prNumber,
    // The address of a task's job is a placeholder (its branch): it is no pull request, whatever it looks like.
    prUrl: job.reviewKind === "implementer" ? null : safeGithubUrl(job.prUrl),
    command: job.command,
    reviewKind: job.reviewKind,
    triggerKind: job.triggerKind,
    trigger: describeTrigger(job.triggerKind, job.actorLogin),
    status: job.status,
    createdAt: job.createdAt,
    startedAt,
    finishedAt: job.finishedAt,
    durationMs: runDurationMs(
      { status: job.status, startedAt, finishedAt: job.finishedAt },
      now,
    ),
    problem: problemOf(product, job),
    // Only a task has the key: the rows of every other kind are what they were.
    ...(job.reviewKind === "implementer"
      ? { implementer: implementerRowView(implementer, redact) }
      : {}),
  };
}

export function toRunDetailView(
  product: ProductIdentity,
  job: Job,
  project: string,
  now: Date,
  /** Removes secrets from the log (the second line of defense after the runner and the result check). */
  redact: (text: string) => string = (text) => text,
  /** Whether the run was on the operator's key (its usage record says so): its cost is not shown. */
  onManagedKey = false,
  /** What the repository knows of the turn of a run of the Implementer (#758); ignored for every other kind. */
  implementer: ImplementerDetailSource | null = null,
): RunDetailView {
  const stored = readStoredResult(job.result);
  // A run on the operator's key never names its provider, also when it was stored before the result was masked on its way in.
  const redactedLog = redact(cleanLog(stored.logTail));
  const cleaned = onManagedKey ? maskProvidersInText(redactedLog) : redactedLog;
  const overlong = cleaned.length > MAX_LOG_CHARS;
  const hasPostedReview =
    job.status === "succeeded" ||
    (job.status === "failed" &&
      job.errorCode !== null &&
      POSTED_REVIEW_ERROR_CODES.includes(job.errorCode));
  const commentUrl = hasPostedReview ? safeGithubUrl(stored.commentUrl) : null;
  // #689: the limit that stopped a Diff Review words its failure; the usage of a failed run carries it.
  const stoppedEarly = readStoredUsage(job.result)?.stoppedEarly ?? null;
  const isTask = job.reviewKind === "implementer";
  const error =
    job.errorCode === null
      ? null
      : describeRunError(product, job.reviewKind, job.errorCode, stoppedEarly);
  // The row's own `implementer` (the list's variant) is replaced below by the detail's, which holds all of it.
  const row: Omit<RunRowView, "implementer"> = toRunRowView(
    product,
    job,
    project,
    now,
    implementer,
  );
  return {
    ...row,
    problem:
      row.problem !== null && job.errorCode === "cost_limit_reached"
        ? (error?.text ?? row.problem)
        : row.problem,
    headSha: job.headSha,
    args: cleanLog(job.args),
    attempts: job.attempts,
    errorCode: error?.code ?? null,
    errorCodeKnown: error?.known ?? false,
    // The reasons are those of a Dynamic Review checkout; a task has none.
    errorReason:
      !isTask && job.status === "failed" && stored.errorReason !== null
        ? describeCheckoutReason(product, stored.errorReason)
        : null,
    commentUrl,
    // A task posts no comment on a pull request, so none can be missing.
    commentMissing:
      !isTask && job.status === "succeeded" && commentUrl === null,
    log: {
      text: overlong ? cleaned.slice(cleaned.length - MAX_LOG_CHARS) : cleaned,
      truncated: stored.logTruncated || overlong,
    },
    supersededBy: job.supersededBy,
    usage: usageView(job, redact, onManagedKey),
    callTrace: traceView(job, onManagedKey),
    costHidden: onManagedKey,
    ...(isTask
      ? {
          implementer: implementerDetailView(
            job,
            implementer,
            redact,
            onManagedKey,
          ),
        }
      : {}),
  };
}

/**
 * The detail of a run for a member: `toRunDetailView` without the log and the call trace, with the review comment the run
 * posted. The text is cleaned and redacted like the log, and on the operator's key it never names its provider.
 */
export function toCustomerRunDetailView(
  product: ProductIdentity,
  job: Job,
  project: string,
  now: Date,
  redact: (text: string) => string = (text) => text,
  onManagedKey = false,
  reviewComment: string | null = null,
  implementer: ImplementerDetailSource | null = null,
): CustomerRunDetailView {
  // Left out here, so neither is ever part of what a member's browser receives.
  const full = toRunDetailView(
    product,
    job,
    project,
    now,
    redact,
    onManagedKey,
    implementer,
  );
  const detail = Object.fromEntries(
    Object.entries(full).filter(
      ([key]) => key !== "log" && key !== "callTrace",
    ),
  ) as Omit<RunDetailView, "log" | "callTrace">;
  const redacted =
    reviewComment === null ? "" : redact(cleanLog(reviewComment)).trim();
  const text = onManagedKey ? maskProvidersInText(redacted) : redacted;
  return { ...detail, reviewText: text === "" ? null : text };
}

function traceView(job: Job, onManagedKey: boolean): RunnerCallTrace | null {
  const trace = readStoredCallTrace(job.result);
  if (trace === null || !onManagedKey) return trace;
  return {
    ...trace,
    // The cost and the cache counts (whether a provider reports cache writes at all, and how many) say which
    // provider answered: a run on the operator's key shows neither. The ending is the protocol's normalised
    // label (the stored trace only holds those), so it stays.
    modelCalls: trace.modelCalls.map((call) => ({
      ...call,
      costUsd: null,
      cacheRead: null,
      cacheWrite: null,
    })),
  };
}

function usageView(
  job: Job,
  redact: (text: string) => string,
  onManagedKey: boolean,
): RunUsageView | null {
  const stored = readStoredUsage(job.result);
  const usage =
    stored !== null && onManagedKey ? { ...stored, costUsd: null } : stored;
  if (usage === null || usage.model === null) return usage;
  // Redaction can lengthen the name: cut again, after it.
  return {
    ...usage,
    model: cutCharacters(redact(usage.model), MAX_MODEL_CHARS),
  };
}
