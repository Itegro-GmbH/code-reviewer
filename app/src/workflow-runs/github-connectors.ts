// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub actions of the engine (#844, milestone 3b): `github.pullRequest.open`, `github.issue.comment` and `github.issue.labels`, and
// the provider-neutral names and the two actions of #917 (`ticket.setStatus`, `ticket.requestReview`).
// They act through the GitHub App of the workspace, on the repository of the run and on nothing else: the repository is never an input,
// so no value can name another one. The inputs are data: the title is one line, texts and lists are bounded, a branch is a plain branch
// name of this repository (no `owner:` prefix that would reach into a fork). Every call passes `call.signal` on and keeps to
// `ACTION_TIMEOUT_MS`; there are no retries of their own. What GitHub refuses becomes a `ConnectorError` with a stable code
// (`docs/workflows.md`, "GitHub actions").
import { IntegrationError } from "../integrations/errors.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import {
  ActionInputError,
  ConnectorError,
  MAY_HAVE_HAPPENED,
  type ActionCall,
  type ActionConnector,
  type RepoInput,
} from "./connectors.ts";
import {
  ACTION_BODY_MAX_CHARS,
  ACTION_TIMEOUT_MS,
  ACTION_BRANCH_MAX_CHARS,
  ACTION_LABELS_MAX,
  ACTION_LABEL_MAX_CHARS,
  ACTION_TITLE_MAX_CHARS,
  GITHUB_REASON_MAX_CHARS,
  actionBudgetMs,
} from "./limits.ts";
import {
  PROJECT_MEMBERS,
  type PullRequestSkipReason,
} from "../workflows/connectors.ts";
import { BIDI_CONTROLS, defuseMentions } from "./templates.ts";
import {
  TicketProviderError,
  type TicketScope,
} from "../integrations/ticket-provider.ts";
import type { TicketTarget } from "./ticket-target.ts";

/** A repository as GitHub names it: an owner and a name. */
const REPOSITORY_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** The connection and the repository an action acts on, resolved for the repository of the run. */
export type GithubActionTarget = {
  provider: IntegrationProvider;
  integration: Integration;
  repo: RepoRef;
};

export type GithubConnectorDeps = {
  /** The target of a run's repository; undefined when the repository or its connection is gone. */
  targetOf(call: ActionCall): Promise<GithubActionTarget | undefined>;
  /**
   * #1094: the target of an active repository of the workspace by its full name (compared without regard to case), for a pull request step
   * with `repos`; undefined when the workspace has no such repository or no active connection for it. Left out, such a step ends with
   * `github_not_found` for every repository.
   */
  targetOfRepository?(
    call: ActionCall,
    fullName: string,
  ): Promise<GithubActionTarget | undefined>;
  /**
   * The ticket provider and the container of its tickets for a run (#1035): what the ticket source of the run's project names; undefined
   * when there is none. The ticket actions (`ticket.comment`, `ticket.labels`, `ticket.setStatus`) act through it, the pull request actions
   * through `targetOf`.
   */
  ticketTargetOf(call: ActionCall): Promise<TicketTarget | undefined>;
  /**
   * The GitHub logins of the members of the project the run belongs to (`reviewers: "project members"` of `ticket.requestReview`, #917);
   * left out where nothing says who they are, which makes that value an `action_input_invalid` of the step.
   */
  projectMembers?(call: ActionCall): Promise<string[]>;
  /**
   * The node id of the board of the project the run's lane belongs to (#922), for a `ticket.setStatus` that names no `board`; undefined
   * when the project has none or nothing says which project it is.
   */
  projectBoard?(call: ActionCall): Promise<string | undefined>;
};

/** What each action needs of the App, as the settings page of the GitHub App words it. */
export const GITHUB_PERMISSION_NEEDED = {
  "github.pullRequest.open":
    "Pull requests: Read and write and Contents: Read-only",
  "github.issue.comment": "Issues: Read and write",
  "github.issue.labels": "Issues: Read and write",
  "ticket.setStatus":
    "Projects: Read and write (an organization permission the owner of the GitHub installation has to opt in to) and Issues: Read-only",
  "ticket.requestReview": "Pull requests: Read and write",
} as const;

const ACTION_VERB = {
  "github.pullRequest.open": "open pull requests",
  "github.issue.comment": "write comments",
  "github.issue.labels": "change labels",
  "ticket.setStatus": "move tickets on a board",
  "ticket.requestReview": "request reviews",
} as const;

type GithubConnectorName = keyof typeof GITHUB_PERMISSION_NEEDED;

/** The actions that create something when they are done twice: after a timeout or an answer of GitHub's own error the step cannot know that nothing was created. */
const NOT_REPEATABLE: ReadonlySet<GithubConnectorName> =
  new Set<GithubConnectorName>([
    "github.pullRequest.open",
    "github.issue.comment",
  ]);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const CONTROL_EXCEPT_LINE_BREAKS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const LINE_BREAKS = /[\u0000-\u001f\u007f\u2028\u2029]+/g;
/** A half of a surrogate pair on its own is no text (JSON carries it as an escape that GitHub may refuse). */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** A label of dots only is a path segment (`.`, `..`) in the address that removes it; the client refuses it as well. */
const DOTS_ONLY = /^\.+$/;
/** A branch of this repository: the characters Git allows without surprises, no `owner:` part, no `..`. */
const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

/** The first `length` code units of a text, without cutting a surrogate pair in two. */
function leading(text: string, length: number): string {
  const splitsPair =
    length > 0 &&
    length < text.length &&
    /[\ud800-\udbff]/.test(text.charAt(length - 1)) &&
    /[\udc00-\udfff]/.test(text.charAt(length));
  return text.slice(0, splitsPair ? length - 1 : length);
}

/**
 * A title is one line: every run of line breaks and control characters becomes one space, bidirectional controls and lone surrogate
 * halves are dropped, and it is cut at GitHub's bound (never inside a surrogate pair).
 */
export function cleanTitle(value: unknown): string {
  if (typeof value !== "string")
    throw new ActionInputError("title must be a text.");
  const line = value
    .replace(BIDI_CONTROLS, "")
    .replace(LONE_SURROGATE, "")
    .replace(LINE_BREAKS, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  if (line === "") throw new ActionInputError("title must not be empty.");
  return line.length <= ACTION_TITLE_MAX_CHARS
    ? line
    : `${leading(line, ACTION_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/** A text of a comment or a description: control characters other than line breaks and tabs and the bidirectional controls are dropped, a long text is cut and says so. */
export function cleanBody(value: unknown, name: string): string {
  if (typeof value !== "string")
    throw new ActionInputError(`${name} must be a text.`);
  const text = value
    .replace(CONTROL_EXCEPT_LINE_BREAKS, "")
    .replace(BIDI_CONTROLS, "")
    .replace(LONE_SURROGATE, "");
  if (text.length <= ACTION_BODY_MAX_CHARS) return text;
  const kept = leading(text, ACTION_BODY_MAX_CHARS);
  const left = text.length - kept.length;
  return `${kept}\n\n… (${String(left)} more characters were left out.)`;
}

function branchName(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > ACTION_BRANCH_MAX_CHARS ||
    !BRANCH_NAME.test(value) ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("//")
  )
    throw new ActionInputError(
      `${name} must be the name of a branch of the repository.`,
    );
  return value;
}

function labelNames(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new ActionInputError(`${name} must be a list of texts.`);
  const names = new Set<string>();
  for (const entry of value) {
    const label = typeof entry === "string" ? entry.trim() : "";
    if (
      label === "" ||
      label.length > ACTION_LABEL_MAX_CHARS ||
      CONTROL_CHARACTERS.test(label) ||
      DOTS_ONLY.test(label)
    )
      throw new ActionInputError(
        `${name} holds a label that is empty, longer than ${String(ACTION_LABEL_MAX_CHARS)} characters, has control characters or is only dots.`,
      );
    names.add(label);
  }
  if (names.size > ACTION_LABELS_MAX)
    throw new ActionInputError(
      `${name} holds more than ${String(ACTION_LABELS_MAX)} labels.`,
    );
  return [...names];
}

function wholeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new ActionInputError(`${name} must be a whole number from 1.`);
  return value;
}

function issueNumber(value: unknown): number {
  return wholeNumber(value, "issue");
}

/** What a text key of a ticket may be made of: `PROJ-123`, `15`. The provider decides whether it can name a ticket of its own (`isTicketKey`). */
const TICKET_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The text key of the ticket an action names: a whole number (a GitHub issue, as before) or the text key of another provider's ticket. */
function ticketKey(value: unknown): string {
  if (typeof value === "string") {
    if (!TICKET_KEY.test(value))
      throw new ActionInputError(
        "ticket must be the key of a ticket: letters, digits, dots, hyphens and underscores, up to 64 characters.",
      );
    return value;
  }
  return String(issueNumber(value));
}

/** What GitHub allows in a user name: letters, digits and single hyphens, up to 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A board is the number of a Project or its node id. */
const BOARD_REFERENCE = /^(?:[1-9]\d{0,9}|PVT_[A-Za-z0-9_-]{1,200})$/;
/** How many people one action asks for a review; GitHub itself allows 15 users per request. */
const REVIEWERS_MAX = 15;
/** How many option names of a board a failure names. */
const BOARD_OPTIONS_SHOWN = 20;

function boardReference(value: unknown): string {
  if (typeof value !== "string" || !BOARD_REFERENCE.test(value))
    throw new ActionInputError(
      "board must be the number of a GitHub Project or its node id.",
    );
  return value;
}

function statusName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > ACTION_LABEL_MAX_CHARS ||
    CONTROL_CHARACTERS.test(value)
  )
    throw new ActionInputError(
      `status must be the name of a status of the board, up to ${String(ACTION_LABEL_MAX_CHARS)} characters, on one line.`,
    );
  return value;
}

/** The logins `reviewers` names, bounded and without doubles; "project members" is not one of them (the caller resolves it). */
function reviewerLogins(value: unknown): string[] {
  if (!Array.isArray(value))
    throw new ActionInputError(
      `reviewers must be "${PROJECT_MEMBERS}" or a list of GitHub logins.`,
    );
  const logins = new Map<string, string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !GITHUB_LOGIN.test(entry))
      throw new ActionInputError(
        "reviewers holds a text that is not a GitHub login.",
      );
    logins.set(entry.toLowerCase(), entry);
  }
  if (logins.size === 0) throw new ActionInputError("reviewers names nobody.");
  if (logins.size > REVIEWERS_MAX)
    throw new ActionInputError(
      `reviewers names more than ${String(REVIEWERS_MAX)} people.`,
    );
  return [...logins.values()];
}

function permissionText(name: GithubConnectorName): string {
  return `The GitHub App of this workspace may not ${ACTION_VERB[name]}: it needs the permission "${GITHUB_PERMISSION_NEEDED[name]}". The owner of the GitHub installation has to grant it in the App's settings and accept the change on the installation; then run the workflow again.`;
}

/** The marks that make a link, an image or markup in Markdown and HTML. */
const MARKUP_MARKS = /[[\]()<>`]/g;
/** A link in any form (`scheme:…`, `//…`, `www.…`), or a word that looks like a GitHub token. GitHub's reason may quote what was sent; neither goes into a step. */
const LINK = /\b[a-z][a-z0-9+.-]*:\S+|\/\/\S+|\bwww\.\S*/gi;
const TOKEN = /\b(?:gh[pousr]_|github_pat_)\w+/g;
/** Characters of no width or no meaning a reader cannot see: the C1 controls, the word joiner, the byte order mark, the soft hyphen. */
const INVISIBLE = /[\u0080-\u009f\u2060\ufeff\u00ad]/g;

/**
 * GitHub's reason for a refusal, as a short line the step may carry, or undefined for none. It is GitHub's text and quotes what
 * the action sent, so it is untrusted data like an agent's: one line without control or invisible characters, the marks of a link or
 * of markup, links or token-looking words, defused so that it cannot mention, close or mark anything where a comment repeats it, and
 * only then cut at `GITHUB_REASON_MAX_CHARS` (never inside a surrogate pair), so that the bound holds for the text as it is kept.
 */
export function cleanReason(value: string | null): string | undefined {
  if (value === null) return undefined;
  const line = value
    .replace(BIDI_CONTROLS, "")
    .replace(INVISIBLE, "")
    .replace(LONE_SURROGATE, "")
    .replace(LINE_BREAKS, " ")
    .replace(MARKUP_MARKS, "")
    .replace(TOKEN, "[token]")
    .replace(LINK, "[link]")
    .replace(/ {2,}/g, " ")
    .trim();
  if (line === "") return undefined;
  const defused = defuseMentions(line);
  return defused.length <= GITHUB_REASON_MAX_CHARS
    ? defused
    : `${leading(defused, GITHUB_REASON_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * What GitHub's refusal means for the step. The message never carries an input of the action or a credential; the permission the
 * action needs is named so that the run page can say what to change, and for a refused value (422) GitHub's own short reason follows
 * the generic sentence (`cleanReason`, #913).
 */
export function toConnectorError(
  name: GithubConnectorName,
  error: unknown,
): Error {
  if (error instanceof ConnectorError || error instanceof ActionInputError)
    return error;
  if (!(error instanceof IntegrationError)) return error as Error;
  switch (error.code) {
    case "INTEGRATION_ACCESS_SCOPE_REFUSED":
      return new ConnectorError(
        "github_permission_missing",
        permissionText(name),
      );
    case "INTEGRATION_ACCESS_CONNECTION_SUSPENDED":
      return new ConnectorError(
        "github_permission_missing",
        `GitHub refuses the App of this workspace access to its installation: the installation may be suspended, or the App lacks the permission "${GITHUB_PERMISSION_NEEDED[name]}".`,
      );
    case "INTEGRATION_ACCESS_CONNECTION_GONE":
      return new ConnectorError(
        "github_not_found",
        "GitHub has no such issue, pull request or repository, or the GitHub installation of this workspace no longer exists.",
      );
    case "INTEGRATION_REPOSITORY_NOT_ACCESSIBLE":
      return new ConnectorError(
        "github_not_found",
        "The repository of the run is not part of the GitHub installation any more.",
      );
    case "INTEGRATION_REPOSITORY_ARCHIVED":
      return new ConnectorError(
        "github_validation",
        "The repository is archived, so GitHub accepts no change to it.",
      );
    case "INTEGRATION_NO_CHANGES_TO_COMPARE":
      return new ConnectorError(
        "github_validation",
        "There are no commits between the head and the base branch, so there is nothing to open a pull request for.",
      );
    case "INTEGRATION_REQUEST_REFUSED": {
      const reason = cleanReason(error.detail);
      return new ConnectorError(
        "github_validation",
        `GitHub refused the request: one of the values is not accepted (for example a branch that does not exist).${reason === undefined ? "" : ` GitHub said: ${reason}${/[.!?…]$/.test(reason) ? "" : "."}`}`,
      );
    }
    case "INTEGRATION_ACCESS_RATE_LIMITED":
      return new ConnectorError(
        "github_rate_limited",
        error.retryAfterSeconds === null
          ? "GitHub's rate limit was reached. The action was not repeated."
          : `GitHub's rate limit was reached; it asks to wait ${String(error.retryAfterSeconds)} seconds. The action was not repeated.`,
      );
    case "INTEGRATION_ACCESS_UNAVAILABLE":
      return new ConnectorError(
        "github_unavailable",
        NOT_REPEATABLE.has(name)
          ? `GitHub could not be reached or did not answer in time. ${MAY_HAVE_HAPPENED}`
          : "GitHub could not be reached or did not answer in time.",
      );
    default:
      return error;
  }
}

async function targetOrFail(
  deps: GithubConnectorDeps,
  call: ActionCall,
): Promise<GithubActionTarget> {
  const target = await deps.targetOf(call);
  if (target === undefined)
    throw new ConnectorError(
      "github_not_found",
      "The repository of the run has no active GitHub connection.",
    );
  return target;
}

async function ticketTargetOrFail(
  deps: GithubConnectorDeps,
  call: ActionCall,
  key: string,
): Promise<TicketTarget> {
  const target = await deps.ticketTargetOf(call);
  if (target === undefined)
    throw new ConnectorError(
      "github_not_found",
      "The repository of the run has no active GitHub connection.",
    );
  if (target.provider.isTicketKey?.(key) === false)
    throw new ActionInputError(
      "ticket must be the key of a ticket of the ticket source of the project.",
    );
  return target;
}

/** The clocks of GitHub and of this server need not agree to the second: the search for an earlier comment starts this much before the step. */
const CLOCK_SKEW_MS = 5 * 60_000;

/** Where the search for the comment of an earlier attempt of the step starts: before it, nothing of the step can exist. */
function searchSince(call: ActionCall): { since?: string } {
  const created = Date.parse(call.stepCreatedAt);
  return Number.isNaN(created)
    ? {}
    : { since: new Date(created - CLOCK_SKEW_MS).toISOString() };
}

/**
 * The address a step reports is a page of the repository of the run: GitHub's answer is taken only when it is one, otherwise the
 * address the repository's own pages have (`fallbackPath`). A step output ends up as a link on the run page.
 */
function pageOfRepository(
  reported: string,
  repo: RepoRef,
  fallbackPath: string,
): string {
  const base = repo.url.replace(/\/+$/, "");
  const fallback = `${base}${fallbackPath}`;
  try {
    const own = new URL(base);
    const page = new URL(reported);
    if (
      page.origin !== own.origin ||
      page.username !== "" ||
      page.password !== ""
    )
      return fallback;
    const segments = (path: string) => path.split("/").filter((s) => s !== "");
    const ownSegments = segments(own.pathname).map((s) => s.toLowerCase());
    const pageSegments = segments(page.pathname);
    const inside =
      pageSegments.length > ownSegments.length &&
      ownSegments.every((s, i) => pageSegments[i]?.toLowerCase() === s);
    return inside ? page.href : fallback;
  } catch {
    return fallback;
  }
}

/**
 * What a ticket action reports when its provider is not GitHub (#1040): a `TicketProviderError` is a step failure with its own code and a
 * text that holds nothing of the platform's answer; anything else is as for GitHub.
 */
function toTicketError(name: GithubConnectorName, error: unknown): Error {
  if (error instanceof TicketProviderError) {
    const code = {
      ticket_not_found: "ticket_not_found",
      ticket_forbidden: "ticket_forbidden",
      ticket_connection_broken: "ticket_connection_broken",
      ticket_unavailable: "ticket_unavailable",
      ticket_rejected: "ticket_rejected",
    } as const;
    return new ConnectorError(
      code[error.code],
      NOT_REPEATABLE.has(name) && error.code === "ticket_unavailable"
        ? `${error.message} ${MAY_HAVE_HAPPENED}`
        : error.message,
    );
  }
  return toConnectorError(name, error);
}

/**
 * The address of the comment a ticket provider reports. A GitHub ticket is a page of the repository of the run (`pageOfRepository`); a ticket
 * that lives elsewhere (Jira) has the address of its own site, taken only when it is an http(s) address without credentials (it ends up as a
 * link on the run page), else none.
 */
function pageOfTicket(
  reported: string,
  scope: TicketScope,
  fallbackPath: string,
): string {
  if (scope.jira === undefined)
    return pageOfRepository(reported, scope.repo, fallbackPath);
  try {
    const page = new URL(reported);
    return (page.protocol === "https:" || page.protocol === "http:") &&
      page.username === "" &&
      page.password === "" &&
      reported.length <= 2000
      ? page.href
      : "";
  } catch {
    return "";
  }
}

function unavailable(name: GithubConnectorName): ConnectorError {
  return new ConnectorError(
    "github_unavailable",
    `The GitHub connection of this workspace cannot ${ACTION_VERB[name]} (${name} is not supported by its provider).`,
  );
}

/**
 * The ticket source of the run's project cannot do this action (#1039): its provider has no such method (Jira's comments, labels and
 * transitions are #1040). A stable code of its own, so a lane's author sees that it is the source and not GitHub.
 */
function ticketUnsupported(
  providerId: string,
  name: GithubConnectorName,
): ConnectorError {
  return new ConnectorError(
    "ticket_provider_unsupported",
    `The ticket source of this project (${providerId}) cannot ${ACTION_VERB[name]} yet.`,
  );
}

/** The failure of a status the board does not have: the options it has, as the board spells them (one line each, bounded). */
function boardStatusText(
  available: readonly string[],
  workflow = false,
): string {
  const shown = available
    .slice(0, BOARD_OPTIONS_SHOWN)
    .map((option) => cleanReason(option))
    .filter((option): option is string => option !== undefined);
  const more =
    available.length > BOARD_OPTIONS_SHOWN
      ? ` and ${String(available.length - BOARD_OPTIONS_SHOWN)} more`
      : "";
  if (workflow)
    return shown.length === 0
      ? "The workflow of the Jira project has no statuses to set."
      : `The workflow of the Jira project has no such status. Its statuses are: ${shown.join(", ")}${more}.`;
  return shown.length === 0
    ? "The board has no Status field with options, so no status can be set."
    : `The board has no such status. Its statuses are: ${shown.join(", ")}${more}.`;
}

/** The failure of a status no transition leads to from the ticket's current one: the statuses that can be reached from there. */
function reachableText(reachable: readonly string[]): string {
  const shown = reachable
    .slice(0, BOARD_OPTIONS_SHOWN)
    .map((option) => cleanReason(option))
    .filter((option): option is string => option !== undefined);
  return shown.length === 0
    ? "No transition of the Jira workflow leads to that status from the ticket's current one, and none leads anywhere else from there. Add the transition in the Jira workflow, or move the ticket by hand."
    : `No transition of the Jira workflow leads to that status from the ticket's current one. From there it can go to: ${shown.join(", ")}. Add the transition in the Jira workflow, or move the ticket by hand.`;
}

export function createGithubConnectors(
  deps: GithubConnectorDeps,
): ActionConnector[] {
  /** One pull request of a step with `repos`: its state, and what it is about, as `pullRequests` lists it. */
  type RepoPullRequest = {
    fullName: string;
    base: string;
    head: string;
    state: "opened" | "existing" | "skipped";
    reason?: PullRequestSkipReason;
    number?: number;
    url?: string;
  };

  /** What a step with `repos` yields: the list, and the single fields of the first pull request that exists (with its repository). */
  function repoOutput(results: readonly RepoPullRequest[]) {
    const first = results.find((entry) => entry.number !== undefined);
    return {
      pullRequests: [...results],
      ...(first === undefined
        ? {}
        : {
            number: first.number,
            url: first.url,
            existing: first.state === "existing",
            repository: first.fullName,
          }),
    };
  }

  /** The codes of a failure that is not one repository's: the same answer would come for the others, so they are not tried. */
  const STOPS_THE_STEP: readonly string[] = [
    "github_unavailable",
    "github_rate_limited",
  ];

  /** The part of the budget kept back so that the step can say what it did before the engine gives up on it. */
  function reserveMs(budgetMs: number): number {
    return Math.min(5000, Math.floor(budgetMs / 10));
  }

  /**
   * #1094 (ADR 0006): one pull request per repository of the list whose branch differs from its base, is pushed and has commits ahead of
   * it, each into its own base and its own repository. A repository that already has an open pull request from that branch gives that
   * one (`existing`); direct work, nothing pushed (or a push the remote refused) and no commits between the branches are skipped, not
   * errors. The others are still tried when one fails; the step then fails with that error, says which pull requests were opened and keeps
   * them as its output. A failure that is not one repository's (rate limit, GitHub unreachable) stops it, and so does the end of its budget
   * (`actionBudgetMs`: it scales with the number of repositories); what was not tried is opened by running the step again (`existing`).
   * An empty list is a step with nothing to open.
   */
  async function openForRepos(
    call: ActionCall,
    repos: readonly RepoInput[],
  ): Promise<Record<string, unknown>> {
    const name = "github.pullRequest.open";
    const draft =
      typeof call.inputs.draft === "boolean" ? call.inputs.draft : undefined;
    // Every entry is checked before the first call is made: a bad title of the third repository must not leave two pull requests behind.
    const plan = repos.map((entry) => {
      const base = branchName(entry.base, "base");
      const head = branchName(entry.branch, "head");
      // Only what will be opened needs its texts: a skipped repository is not held to them.
      const opens = head !== base && entry.pushed;
      return {
        entry,
        base,
        head,
        title: opens ? cleanTitle(entry.title) : "",
        body:
          opens && entry.body !== undefined
            ? cleanBody(entry.body, "body")
            : undefined,
      };
    });
    const budget = call.budgetMs ?? ACTION_TIMEOUT_MS;
    const stopAt = Date.now() + budget - reserveMs(budget);
    const results: RepoPullRequest[] = [];
    let failure: ConnectorError | undefined;
    let untried = 0;
    for (const [index, { entry, base, head, title, body }] of plan.entries()) {
      const skipped = (reason: PullRequestSkipReason): RepoPullRequest => ({
        fullName: entry.fullName,
        base,
        head,
        state: "skipped",
        reason,
      });
      if (head === base) {
        results.push(skipped("direct"));
        continue;
      }
      if (!entry.pushed) {
        results.push(
          skipped(entry.pushRejected ? "push_rejected" : "not_pushed"),
        );
        continue;
      }
      if (Date.now() >= stopAt) {
        untried = plan.length - index;
        failure ??= new ConnectorError(
          "action_timeout",
          "The step ran out of time before it had tried every repository. Run it again: pull requests that exist are found, not opened twice.",
        );
        break;
      }
      const target = await deps.targetOfRepository?.(call, entry.fullName);
      if (target === undefined) {
        failure ??= new ConnectorError(
          "github_not_found",
          `The repository ${entry.fullName} is not an active repository of this workspace with a GitHub connection.`,
        );
        continue;
      }
      const { provider, integration, repo } = target;
      if (provider.openPullRequest === undefined) throw unavailable(name);
      try {
        const opened = await provider.openPullRequest(
          integration,
          repo,
          {
            head,
            base,
            title,
            ...(body === undefined ? {} : { body }),
            ...(draft === undefined ? {} : { draft }),
          },
          call.signal,
        );
        results.push({
          fullName: entry.fullName,
          base,
          head,
          state: opened.existing ? "existing" : "opened",
          number: opened.number,
          url: pageOfRepository(
            opened.url,
            repo,
            `/pull/${String(opened.number)}`,
          ),
        });
      } catch (error) {
        if (
          error instanceof IntegrationError &&
          error.code === "INTEGRATION_NO_CHANGES_TO_COMPARE"
        ) {
          results.push(skipped("no_commits"));
          continue;
        }
        const failed = toConnectorError(name, error);
        // What is not a failure of the connector (an unexpected throw) is not for people to read, but the pull requests before it are.
        const known =
          failed instanceof ConnectorError
            ? failed
            : failed instanceof ActionInputError
              ? new ConnectorError("action_failed", failed.message)
              : new ConnectorError(
                  "action_failed",
                  `The action failed for ${entry.fullName}.`,
                );
        failure ??= known;
        // An answer that is the same for every repository (the rate limit) or may not have been seen (unreachable) stops the step at once.
        if (STOPS_THE_STEP.includes(known.code)) {
          untried = plan.length - index - 1;
          break;
        }
      }
    }
    if (failure !== undefined) {
      const done = results
        .filter((entry) => entry.number !== undefined)
        .map((entry) => `${entry.fullName}#${String(entry.number)}`);
      const notTried =
        untried > 0
          ? ` ${String(untried)} repositor${untried === 1 ? "y was" : "ies were"} not tried.`
          : "";
      throw new ConnectorError(
        failure.code,
        `${failure.message}${notTried}${done.length === 0 ? "" : ` Pull requests that were opened or found before: ${done.join(", ")}.`}`,
        repoOutput(results),
      );
    }
    return repoOutput(results);
  }

  const pullRequestOpen: ActionConnector = {
    name: "github.pullRequest.open",
    // #1094: with `repos` the step gets a share of time for every repository (`actionBudgetMs`).
    budgetMs: (inputs) =>
      Array.isArray(inputs.repos)
        ? actionBudgetMs(inputs.repos.length)
        : ACTION_TIMEOUT_MS,
    async run(call) {
      const name = "github.pullRequest.open";
      if (Array.isArray(call.inputs.repos))
        return openForRepos(call, call.inputs.repos as RepoInput[]);
      const head = branchName(call.inputs.head, "head");
      const base = branchName(call.inputs.base ?? call.baseBranch, "base");
      if (head === base)
        throw new ActionInputError("head and base are the same branch.");
      const title = cleanTitle(call.inputs.title);
      const body =
        call.inputs.body === undefined
          ? undefined
          : cleanBody(call.inputs.body, "body");
      const draft =
        typeof call.inputs.draft === "boolean" ? call.inputs.draft : undefined;
      const { provider, integration, repo } = await targetOrFail(deps, call);
      if (provider.openPullRequest === undefined) throw unavailable(name);
      try {
        const opened = await provider.openPullRequest(
          integration,
          repo,
          {
            head,
            base,
            title,
            ...(body === undefined ? {} : { body }),
            ...(draft === undefined ? {} : { draft }),
          },
          call.signal,
        );
        return {
          number: opened.number,
          url: pageOfRepository(
            opened.url,
            repo,
            `/pull/${String(opened.number)}`,
          ),
          existing: opened.existing,
        };
      } catch (error) {
        throw toConnectorError(name, error);
      }
    },
  };

  /** The marker of one step of one run: a call that is made again for the same step finds its comment instead of writing a second one. */
  const commentBody = (call: ActionCall) => {
    const body = cleanBody(call.inputs.body, "body");
    if (body.trim() === "")
      throw new ActionInputError("body must not be empty.");
    // An invisible marker of this step of this run. It holds within one run; a new run is a new comment.
    const marker = `<!-- ${call.idempotencyKey} -->`;
    return { body: `${body}\n\n${marker}`, marker };
  };

  const issueComment: ActionConnector = {
    name: "github.issue.comment",
    async run(call) {
      const name = "github.issue.comment";
      const issue = issueNumber(call.inputs.issue);
      const { body, marker } = commentBody(call);
      const { provider, integration, repo } = await targetOrFail(deps, call);
      if (provider.commentOnIssue === undefined) throw unavailable(name);
      try {
        const { url, existing } = await provider.commentOnIssue(
          integration,
          repo,
          issue,
          body,
          { signal: call.signal, marker, ...searchSince(call) },
        );
        return {
          url: pageOfRepository(url, repo, `/issues/${String(issue)}`),
          existing,
        };
      } catch (error) {
        throw toConnectorError(name, error);
      }
    },
  };

  const ticketComment: ActionConnector = {
    name: "ticket.comment",
    async run(call) {
      // The messages of a failure name the GitHub action that `ticket.comment` was before #1035.
      const name = "github.issue.comment";
      const key = ticketKey(call.inputs.ticket);
      const { body, marker } = commentBody(call);
      const { provider, scope } = await ticketTargetOrFail(deps, call, key);
      if (provider.commentOnTicket === undefined)
        throw ticketUnsupported(provider.id, name);
      try {
        const { url, existing } = await provider.commentOnTicket(
          scope,
          key,
          body,
          { signal: call.signal, marker, ...searchSince(call) },
        );
        return {
          url: pageOfTicket(url, scope, `/issues/${key}`),
          existing,
        };
      } catch (error) {
        throw toTicketError(name, error);
      }
    },
  };

  const labelChange = (call: ActionCall) => {
    const add = labelNames(call.inputs.add, "add");
    const remove = labelNames(call.inputs.remove, "remove");
    if (add.length === 0 && remove.length === 0)
      throw new ActionInputError(
        "At least one label to add or remove is needed.",
      );
    return { add, remove };
  };

  const issueLabels: ActionConnector = {
    name: "github.issue.labels",
    idempotent: true,
    async run(call) {
      const name = "github.issue.labels";
      const issue = issueNumber(call.inputs.issue);
      const change = labelChange(call);
      const { provider, integration, repo } = await targetOrFail(deps, call);
      if (provider.changeIssueLabels === undefined) throw unavailable(name);
      try {
        const { labels } = await provider.changeIssueLabels(
          integration,
          repo,
          issue,
          change,
          call.signal,
        );
        return { labels };
      } catch (error) {
        throw toConnectorError(name, error);
      }
    },
  };

  const ticketLabels: ActionConnector = {
    name: "ticket.labels",
    idempotent: true,
    async run(call) {
      const name = "github.issue.labels";
      const key = ticketKey(call.inputs.ticket);
      const change = labelChange(call);
      const { provider, scope } = await ticketTargetOrFail(deps, call, key);
      if (provider.changeTicketLabels === undefined)
        throw ticketUnsupported(provider.id, name);
      try {
        const { labels } = await provider.changeTicketLabels(
          scope,
          key,
          change,
          call.signal,
        );
        return { labels };
      } catch (error) {
        throw toTicketError(name, error);
      }
    },
  };

  const setStatus: ActionConnector = {
    name: "ticket.setStatus",
    idempotent: true,
    async run(call) {
      const name = "ticket.setStatus";
      const key = ticketKey(call.inputs.ticket);
      const status = statusName(call.inputs.status);
      const { provider, scope } = await ticketTargetOrFail(deps, call, key);
      if (provider.setTicketStatus === undefined)
        throw ticketUnsupported(provider.id, name);
      // The board of the project, unless the step names one (an override that stays accepted). A provider whose statuses are no board
      // columns (Jira: the transitions of the ticket's workflow) needs none.
      let board: string | undefined;
      if (provider.boardless !== true) {
        const named = call.inputs.board;
        const projectBoard =
          named === undefined ? await deps.projectBoard?.(call) : undefined;
        if (named === undefined && projectBoard === undefined)
          throw new ActionInputError(
            "The project of this lane has no board: set one on the project, or name it with board.",
          );
        board = boardReference(named ?? projectBoard);
      }
      try {
        const moved = await provider.setTicketStatus(
          scope,
          key,
          { ...(board === undefined ? {} : { board }), status },
          call.signal,
        );
        switch (moved.kind) {
          case "moved":
            return { status: moved.status };
          case "issue_not_found":
            throw provider.boardless === true
              ? new ConnectorError(
                  "ticket_not_found",
                  "Jira has no issue with that key in the Jira project of this project.",
                )
              : new ConnectorError(
                  "github_not_found",
                  "GitHub has no issue with that number in the repository of the run.",
                );
          case "board_not_found":
            throw new ConnectorError(
              "github_not_found",
              "The GitHub App of this workspace cannot find that GitHub Project among the projects of the repository's owner. Check the number of the board and that the App may read the owner's projects.",
            );
          case "status_unknown":
            throw new ConnectorError(
              provider.boardless === true
                ? "ticket_status_unknown"
                : "board_status_unknown",
              boardStatusText(moved.available, provider.boardless === true),
            );
          case "status_unreachable":
            throw new ConnectorError(
              "ticket_status_unreachable",
              reachableText(moved.reachable),
            );
        }
      } catch (error) {
        throw toTicketError(name, error);
      }
    },
  };

  async function reviewTargetOf(call: ActionCall): Promise<GithubActionTarget> {
    const named = call.inputs.repository;
    if (named === undefined) return targetOrFail(deps, call);
    if (typeof named !== "string" || !REPOSITORY_NAME.test(named))
      throw new ActionInputError(
        "repository must be a repository like owner/name.",
      );
    const target = await deps.targetOfRepository?.(call, named);
    if (target === undefined)
      throw new ConnectorError(
        "github_not_found",
        `The repository ${named} is not an active repository of this workspace with a GitHub connection.`,
      );
    return target;
  }

  const requestReview: ActionConnector = {
    name: "ticket.requestReview",
    idempotent: true,
    async run(call) {
      const name = "ticket.requestReview";
      // #1094: the pull request step with `repos` opened none (every repository skipped), so there is nothing to ask a review of: the step
      // skips, and does not fall back on some other pull request of the run's repository.
      if (call.inputs.pullRequest === undefined)
        return { requested: [], skipped: "no_pull_request" };
      const pullRequest = wholeNumber(call.inputs.pullRequest, "pullRequest");
      const { reviewers } = call.inputs;
      const members = reviewers === PROJECT_MEMBERS;
      if (typeof reviewers === "string" && !members)
        throw new ActionInputError(
          `reviewers must be "${PROJECT_MEMBERS}" or a list of GitHub logins.`,
        );
      let logins: string[];
      if (members) {
        if (deps.projectMembers === undefined)
          throw new ActionInputError(
            `"${PROJECT_MEMBERS}" cannot be resolved on this server; name the logins.`,
          );
        // All of them, in the order they joined: GitHub decides who can review, and the first REVIEWERS_MAX it accepts are asked.
        const known = new Map<string, string>();
        for (const login of await deps.projectMembers(call))
          if (GITHUB_LOGIN.test(login) && !known.has(login.toLowerCase()))
            known.set(login.toLowerCase(), login);
        if (known.size === 0)
          throw new ActionInputError(
            "None of the members of the project has a GitHub login to ask for a review.",
          );
        logins = [...known.values()];
      } else logins = reviewerLogins(reviewers);
      // The pull request may be in another repository than the run's (the first one of a step with `repos`): it is named, and only a repository
      // of the workspace with an active connection is acted on.
      const { provider, integration, repo } = await reviewTargetOf(call);
      if (provider.requestReviewers === undefined) throw unavailable(name);
      try {
        // The members of a project need not all be able to review this pull request (a collaborator of the repository, not its author),
        // so they are asked one by one, in order, until REVIEWERS_MAX are accepted; the ones GitHub refuses for that reason are left
        // out. People the lane names are asked for as they are.
        const { requested } = await provider.requestReviewers(
          integration,
          repo,
          pullRequest,
          logins,
          {
            skipRefused: members,
            ...(members ? { max: REVIEWERS_MAX } : {}),
            signal: call.signal,
          },
        );
        if (members && requested.length === 0)
          throw new ConnectorError(
            "github_validation",
            "GitHub accepted none of the members of the project as reviewers: they are not collaborators of the repository, or the author of the pull request. Add them to the repository or name other reviewers.",
          );
        return { requested };
      } catch (error) {
        throw toConnectorError(name, error);
      }
    },
  };

  // The provider-neutral names of the actions that stay with the git provider (#916): the same action under another name, with the input that
  // names the target renamed to the one the GitHub action calls it. The target is the issue or pull request of the repository of the run.
  // `ticket.comment` and `ticket.labels` are not aliases any more (#1035): they act through the ticket provider of the project's source.
  const alias = (
    neutral: string,
    connector: ActionConnector,
    input?: string,
  ): ActionConnector => ({
    name: neutral,
    ...(connector.idempotent === true ? { idempotent: true } : {}),
    run: (call) =>
      connector.run(
        input === undefined
          ? call
          : { ...call, inputs: { ...call.inputs, issue: call.inputs[input] } },
      ),
  });

  return [
    pullRequestOpen,
    issueComment,
    issueLabels,
    alias("pullRequest.open", pullRequestOpen),
    alias("pullRequest.comment", issueComment, "pullRequest"),
    ticketComment,
    ticketLabels,
    setStatus,
    requestReview,
  ];
}
