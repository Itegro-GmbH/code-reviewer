// SPDX-License-Identifier: LicenseRef-Proprietary

// The three GitHub actions of the engine (#844, milestone 3b): `github.pullRequest.open`, `github.issue.comment` and `github.issue.labels`.
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
} from "./connectors.ts";
import {
  ACTION_BODY_MAX_CHARS,
  ACTION_BRANCH_MAX_CHARS,
  ACTION_LABELS_MAX,
  ACTION_LABEL_MAX_CHARS,
  ACTION_TITLE_MAX_CHARS,
  GITHUB_REASON_MAX_CHARS,
} from "./limits.ts";
import { BIDI_CONTROLS, defuseMentions } from "./templates.ts";

/** The connection and the repository an action acts on, resolved for the repository of the run. */
export type GithubActionTarget = {
  provider: IntegrationProvider;
  integration: Integration;
  repo: RepoRef;
};

export type GithubConnectorDeps = {
  /** The target of a run's repository; undefined when the repository or its connection is gone. */
  targetOf(call: ActionCall): Promise<GithubActionTarget | undefined>;
};

/** What each action needs of the App, as the settings page of the GitHub App words it. */
export const GITHUB_PERMISSION_NEEDED = {
  "github.pullRequest.open":
    "Pull requests: Read and write and Contents: Read-only",
  "github.issue.comment": "Issues: Read and write",
  "github.issue.labels": "Issues: Read and write",
} as const;

const ACTION_VERB = {
  "github.pullRequest.open": "open pull requests",
  "github.issue.comment": "write comments",
  "github.issue.labels": "change labels",
} as const;

type GithubConnectorName = keyof typeof GITHUB_PERMISSION_NEEDED;

/** The actions that create something when they are done twice: after a timeout or an answer of GitHub's own error the step cannot know that nothing was created. */
const NOT_REPEATABLE: ReadonlySet<GithubConnectorName> = new Set([
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

function issueNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new ActionInputError("issue must be a whole number from 1.");
  return value;
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

function unavailable(name: GithubConnectorName): ConnectorError {
  return new ConnectorError(
    "github_unavailable",
    `The GitHub connection of this workspace cannot ${ACTION_VERB[name]} (${name} is not supported by its provider).`,
  );
}

export function createGithubConnectors(
  deps: GithubConnectorDeps,
): ActionConnector[] {
  const pullRequestOpen: ActionConnector = {
    name: "github.pullRequest.open",
    async run(call) {
      const name = "github.pullRequest.open";
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

  const issueComment: ActionConnector = {
    name: "github.issue.comment",
    async run(call) {
      const name = "github.issue.comment";
      const issue = issueNumber(call.inputs.issue);
      const body = cleanBody(call.inputs.body, "body");
      if (body.trim() === "")
        throw new ActionInputError("body must not be empty.");
      const { provider, integration, repo } = await targetOrFail(deps, call);
      if (provider.commentOnIssue === undefined) throw unavailable(name);
      // An invisible marker of this step of this run: a call that is made again for the same step finds its comment instead of
      // writing a second one. It holds within one run; a new run is a new comment.
      const marker = `<!-- ${call.idempotencyKey} -->`;
      try {
        const { url, existing } = await provider.commentOnIssue(
          integration,
          repo,
          issue,
          `${body}\n\n${marker}`,
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

  const issueLabels: ActionConnector = {
    name: "github.issue.labels",
    idempotent: true,
    async run(call) {
      const name = "github.issue.labels";
      const issue = issueNumber(call.inputs.issue);
      const add = labelNames(call.inputs.add, "add");
      const remove = labelNames(call.inputs.remove, "remove");
      if (add.length === 0 && remove.length === 0)
        throw new ActionInputError(
          "At least one label to add or remove is needed.",
        );
      const { provider, integration, repo } = await targetOrFail(deps, call);
      if (provider.changeIssueLabels === undefined) throw unavailable(name);
      try {
        const { labels } = await provider.changeIssueLabels(
          integration,
          repo,
          issue,
          { add, remove },
          call.signal,
        );
        return { labels };
      } catch (error) {
        throw toConnectorError(name, error);
      }
    },
  };

  // #916: the provider-neutral names of the two actions on a ticket. The ticket is the issue of the repository of the run, so each is the
  // GitHub action with the same inputs and `ticket` where it has `issue`.
  const onTicket = (
    neutral: string,
    connector: ActionConnector,
  ): ActionConnector => ({
    name: neutral,
    ...(connector.idempotent === true ? { idempotent: true } : {}),
    run: (call) =>
      connector.run({
        ...call,
        inputs: { ...call.inputs, issue: call.inputs.ticket },
      }),
  });

  return [
    pullRequestOpen,
    issueComment,
    issueLabels,
    onTicket("ticket.comment", issueComment),
    onTicket("ticket.labels", issueLabels),
  ];
}
