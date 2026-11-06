// SPDX-License-Identifier: LicenseRef-Proprietary

// A small GitHub client for the app: authenticates as the app (JWT) and as an installation (token),
// lists installations and their repositories, reads pull requests and permissions. Everything it
// returns is already in the shapes the provider needs; nothing outside this folder sees GitHub JSON.
//
// Errors are `GithubAppError`s with a stable code (see errors.ts). A message names the call and the
// status only: never the JWT, a token, a key or a response body.
import type { GithubAppConfig } from "./config.ts";
import { GithubAppError, type GithubRefusalReason } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { createAppJwt } from "./jwt.ts";
import { toPullRequestRef } from "./mappers.ts";
import type { PullRequestRef } from "../../types.ts";

export type RemoteInstallation = {
  /** The installation id as text. */
  id: string;
  accountLogin: string;
  accountId: number;
  accountType: string;
  suspended: boolean;
  /**
   * The permissions the installation holds, by API name (`GET /app/installations/:id`): what its owner accepted, which
   * can be less than the App asks for. Empty when GitHub did not say (#749).
   */
  permissions: Readonly<Record<string, string>>;
};

export type RemoteRepository = {
  externalId: string;
  /** "owner/name". */
  fullName: string;
  url: string;
};

/** The app as `GET /app` describes it to its own JWT. */
export type RemoteApp = {
  /** The app id as text. */
  id: string;
  slug: string;
  /** The account the App belongs to (`owner` of `GET /app`), or null when GitHub does not say. */
  owner: { id: number; login: string } | null;
  /** The permissions the App holds, by API name (`pull_requests`, `emails`, `members`, ...). */
  permissions: Record<string, string>;
};

export type CollaboratorPermission = "admin" | "write" | "read" | "none";

export type InstallationToken = {
  token: string;
  /** ISO 8601 text in UTC. */
  expiresAt: string;
};

/** GitHub's permission names mapped to a level; what a token request asks for and a token holds. */
export type InstallationPermissions = Readonly<
  Record<string, "read" | "write">
>;

/** What a job token is limited to. Both parts are required: a job token is never broader. */
export type JobTokenScope = {
  /** The numeric ids of the repositories (at least one) the token may reach. */
  repositoryIds: readonly number[];
  permissions: InstallationPermissions;
};

/** A comment below a pull request, as far as the app needs it. */
export type IssueComment = {
  /** The comment id as text. */
  id: string;
  body: string;
  /** The login of the author (`<slug>[bot]` for the app's own comments). */
  authorLogin: string;
};

/** The pull request (or issue) a comment sits below, read from the links of the comment. */
export type CommentTarget = { repoFullName: string; number: number };

/** A comment read by its id (#657): the pull request it sits below is known when GitHub's links name it. */
export type ReadIssueComment = IssueComment & {
  /** From `issue_url`, else `html_url`; null when neither is a link to a pull request or issue of a repository. */
  below: CommentTarget | null;
};

/** The fields of a check run (#405) that the app writes: the name and commit only when it is created. */
export type CheckRunFields = {
  status: "queued" | "in_progress" | "completed";
  /** Required with `completed`. The app only ever uses `success` and `neutral`: a check run is never red. */
  conclusion?: "success" | "neutral";
  /** The id of the job, so a check run that was created but whose id was not kept can be found again. */
  externalId?: string;
  detailsUrl?: string;
  /** ISO 8601 text in UTC. */
  startedAt?: string;
  completedAt?: string;
  output?: { title: string; summary: string };
};

export type NewCheckRun = CheckRunFields & { name: string; headSha: string };

/** A pull request to open (#844): `head` is a branch of the repository itself. */
export type NewPullRequest = {
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
};

/** A pull request as the engine's action reports it; `existing` when it was open before the call. */
export type OpenedPullRequest = {
  number: number;
  url: string;
  existing: boolean;
};

/** A review of a pull request (#405), as far as the app needs it. */
export type PullRequestReview = {
  id: string;
  body: string;
  /** The login of the author (`<slug>[bot]` for the app's own reviews). */
  authorLogin: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`. */
  state: string;
};

export type NewPullRequestReview = {
  commitId: string;
  body: string;
  event: "APPROVE" | "REQUEST_CHANGES";
};

export type GithubAppClient = {
  /**
   * The app itself (`GET /app`, App JWT): proves that the key belongs to the app id, and says what the
   * App is granted. Rejects with GITHUB_APP_AUTH_FAILED when GitHub refuses the JWT.
   */
  getApp(): Promise<RemoteApp>;
  /** Every installation of the app (needs the App JWT). */
  listInstallations(): Promise<RemoteInstallation[]>;
  /** One installation, or null when GitHub does not know it (it was removed, or is not ours). */
  getInstallation(installationId: string): Promise<RemoteInstallation | null>;
  /** Every repository the installation may see, all pages. Rejects when a page cannot be read. */
  listInstallationRepositories(
    installationId: string,
  ): Promise<RemoteRepository[]>;
  /**
   * Rejects with GITHUB_APP_NOT_FOUND for an unknown pull request. When `signal` fires, the HTTP
   * request in flight is aborted (the connection is closed) and the call rejects with
   * GITHUB_APP_UNAVAILABLE.
   */
  getPullRequest(
    installationId: string,
    repoFullName: string,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<PullRequestRef>;
  /** Aborts like `getPullRequest` when `signal` fires, also between two pages. */
  listOpenPullRequests(
    installationId: string,
    repoFullName: string,
    signal?: AbortSignal,
  ): Promise<PullRequestRef[]>;
  /**
   * The default branch of a repository (#750), read with a token of its own limited to `scope` (minted for this
   * call and switched off after it, like the other scoped reads). Aborts like `getPullRequest`.
   */
  getRepositoryFacts(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    signal?: AbortSignal,
  ): Promise<{ defaultBranch: string }>;
  /**
   * The first `BRANCH_LIST_LIMIT` branch names of a repository, the default branch first and the others by name
   * (#750), and whether there are more. Reads one page of that size and, when it is full, a second to see whether
   * anything follows; same token and abort rules as `getRepositoryFacts`.
   */
  listBranches(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    signal?: AbortSignal,
  ): Promise<{ names: string[]; truncated: boolean }>;
  /**
   * One branch (#750): its head commit, or null when the repository has no branch of that name (a 404 of the
   * branch itself; a 404 of the token request is an installation that is gone and rejects). The name is any
   * branch name, `feature/x` included; same token and abort rules as `getRepositoryFacts`.
   */
  getBranch(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string } | null>;
  /** The repository permission of a user; "none" for a user GitHub does not know. */
  getCollaboratorPermission(
    installationId: string,
    repoFullName: string,
    login: string,
  ): Promise<CollaboratorPermission>;
  /**
   * Comments below a pull request, all pages, read with a token of its own limited to `scope` (minted for
   * this call and switched off after it). `since` (ISO 8601) asks GitHub only for the comments changed
   * after it. Nothing here is a pull request's own text: the caller looks only at the author and a marker.
   */
  listIssueComments(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    prNumber: number,
    options?: { since?: string; signal?: AbortSignal },
  ): Promise<IssueComment[]>;
  /**
   * One comment below a pull request by its id (#657; `GET .../issues/comments/{id}`), read with a token of its own
   * limited to `scope`. null when there is no such comment (it was deleted). Nothing here is the pull request's own
   * text: the caller keeps the body as untrusted data.
   */
  getIssueComment(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    commentId: string,
    signal?: AbortSignal,
  ): Promise<ReadIssueComment | null>;
  /**
   * Writes a comment below a pull request as the app, with a token of its own limited to `scope` (minted
   * for this call and switched off after it, also when the call fails). Rejects with the stable code of the
   * answer (403 `GITHUB_APP_FORBIDDEN`, 404 `GITHUB_APP_NOT_FOUND`, ...); the body is never part of a message.
   */
  createIssueComment(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    prNumber: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; url: string }>;
  /**
   * Opens a pull request as the app (#844), with a token of its own limited to `scope`, switched off after the call. An open pull
   * request from `head` into `base` is the result (`existing`) instead of a second one or an error: it is looked for first, and again
   * when GitHub answers 422 because one exists. Other failures reject with the stable code of the answer; a 422 says why in `refusal`
   * (`no_commits_between`). Aborts like `getPullRequest`.
   */
  openPullRequest(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    input: NewPullRequest,
    signal?: AbortSignal,
  ): Promise<OpenedPullRequest>;
  /**
   * Adds and removes labels of an issue or pull request (#844), with a token limited to `scope`. Both are idempotent: an added label
   * that is on the issue stays, a removed one that is not on it is skipped; a label the repository lacks is created by the add.
   * Answers every label on the issue afterwards. 404 when there is no such issue. Aborts like `getPullRequest`.
   */
  changeIssueLabels(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    issueNumber: number,
    change: { add: readonly string[]; remove: readonly string[] },
    signal?: AbortSignal,
  ): Promise<string[]>;
  /**
   * Creates the check run of a review on a commit (#405), as the app, with a token of its own limited to `scope`
   * (minted for this call and switched off after it, also when the call fails). Rejects with the stable code of
   * the answer; an App that was not granted the Checks permission fails while the token is requested (422, see
   * `duringTokenRequest`) or with 403.
   */
  createCheckRun(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    input: NewCheckRun,
    signal?: AbortSignal,
  ): Promise<{ id: string }>;
  /** Changes a check run that `createCheckRun` made. Same token rules and failures. */
  updateCheckRun(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    checkRunId: string,
    input: Partial<CheckRunFields>,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * The check run of the app with this name and external id on the commit, or null: how a check run is found
   * again when it was created and its id was not kept (the process died between the two).
   */
  findCheckRun(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    lookup: { headSha: string; name: string; externalId: string },
    signal?: AbortSignal,
  ): Promise<{ id: string } | null>;
  /**
   * Submits a review of a pull request as the app (#405), with a token limited to `scope`. The body is the
   * caller's: it must not carry anything of the pull request.
   */
  createPullRequestReview(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    prNumber: number,
    input: NewPullRequestReview,
    signal?: AbortSignal,
  ): Promise<{ id: string }>;
  /** The reviews of a pull request, all pages. Only the author, the state and the body are read. */
  listPullRequestReviews(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<PullRequestReview[]>;
  /**
   * Dismisses a review of a pull request with a message (#405; `PUT .../reviews/{id}/dismissals`), with a token
   * limited to `scope`. The caller makes sure the review is the app's own.
   */
  dismissPullRequestReview(
    installationId: string,
    scope: JobTokenScope,
    repoFullName: string,
    prNumber: number,
    reviewId: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Mints a fresh installation access token, never from the cache, limited to the given repositories
   * and permissions. The one place a token for a job is created. Refuses (without a request) a scope
   * with no repository or no permission, and a token GitHub reports as broader than asked for.
   */
  mintInstallationToken(
    installationId: string,
    scope: JobTokenScope,
  ): Promise<InstallationToken>;
  /**
   * Switches an installation token off (`DELETE /installation/token`, #753). Never rejects, because it runs where the caller
   * already has a failure to report or a job that is over. Answers whether the token is off: `true` when GitHub switched it off
   * (2xx) or says it is not valid any more (401: revoked before, or expired); `false` for anything else (a server error, a rate
   * limit, a refusal, no answer in time, no connection), when the token may still work and the caller keeps it to try again.
   * The body of the answer is never read, so nothing of it can reach a message.
   */
  revokeInstallationToken(token: string): Promise<boolean>;
};

export type GithubAppClientOptions = {
  config: GithubAppConfig;
  /** Default: the global fetch at call time. */
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. Default Date.now. */
  now?: () => number;
  /** How long one request may take before it counts as unavailable. Default 15 seconds. */
  requestTimeoutMs?: number;
  /**
   * How long switching a token off may take. Default 3 seconds: it is a courtesy of a few bytes, and must not make
   * a call outlast the time its caller has (#405).
   */
  revokeTimeoutMs?: number;
  /** Receives a warning about a record that is skipped. Default: console.warn. */
  warn?: (line: string) => void;
};

const PAGE_SIZE = 100;
/** How many branch names `listBranches` returns at most. */
export const BRANCH_LIST_LIMIT = 100;
/** A hard stop so a misbehaving server cannot loop us forever; reaching it is an error, not a cut. */
const MAX_PAGES = 100;
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
/** A JWT lives about 9 minutes (see jwt.ts); reuse it for 5 so it never expires mid-call. */
const JWT_REUSE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REVOKE_TIMEOUT_MS = 3_000;
const GITHUB_API_VERSION = "2022-11-28";
/** The longest text of GitHub's reason for a refused call that is kept (#913). */
const REASON_MAX_CHARS = 300;

function shapeError(call: string): GithubAppError {
  return new GithubAppError(
    "GITHUB_APP_REQUEST_FAILED",
    `GitHub answered ${call} in an unexpected format.`,
  );
}

/**
 * One installation record. Returns `skip` for a record whose account has no login or type (for
 * example some enterprise accounts), so one odd record cannot block the whole listing; throws for a
 * record that is not even an installation.
 */
function toInstallation(
  value: unknown,
  call: string,
): RemoteInstallation | { skip: string } {
  if (!isRecord(value) || typeof value.id !== "number") throw shapeError(call);
  const { id, account } = value;
  if (
    !isRecord(account) ||
    typeof account.login !== "string" ||
    typeof account.id !== "number" ||
    typeof account.type !== "string"
  )
    return { skip: `installation ${id}: its account has no login, id or type` };
  return {
    id: String(id),
    accountLogin: account.login,
    accountId: account.id,
    accountType: account.type,
    suspended: typeof value.suspended_at === "string",
    permissions: toPermissions(value.permissions),
  };
}

/** The `permissions` object of GitHub (name to level); anything that is not text is left out, a missing object is empty. */
function toPermissions(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function toRepository(value: unknown, call: string): RemoteRepository {
  if (!isRecord(value)) throw shapeError(call);
  if (
    typeof value.id !== "number" ||
    typeof value.full_name !== "string" ||
    typeof value.html_url !== "string"
  )
    throw shapeError(call);
  return {
    externalId: String(value.id),
    fullName: value.full_name,
    url: value.html_url,
  };
}

const ISSUE_URL =
  /^https:\/\/[^/]+\/(?:api\/v3\/)?repos\/([^/]+\/[^/]+)\/issues\/(\d{1,10})$/;
const COMMENT_HTML_URL =
  /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d{1,10})#issuecomment-\d{1,20}$/;

/** The pull request or issue a comment answers to, from `issue_url` and else `html_url`. */
export function commentTarget(
  value: Record<string, unknown>,
): CommentTarget | null {
  for (const [field, pattern] of [
    ["issue_url", ISSUE_URL],
    ["html_url", COMMENT_HTML_URL],
  ] as const) {
    const link = value[field];
    const match = typeof link === "string" ? pattern.exec(link) : null;
    if (match?.[1] !== undefined && match[2] !== undefined)
      return { repoFullName: match[1], number: Number(match[2]) };
  }
  return null;
}

function toIssueComment(
  value: unknown,
  call = "GET /repos/{owner}/{repo}/issues/{n}/comments",
): IssueComment {
  const user = isRecord(value) ? value.user : undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.body !== "string" ||
    !isRecord(user) ||
    typeof user.login !== "string"
  )
    throw shapeError(call);
  return { id: String(value.id), body: value.body, authorLogin: user.login };
}

function toPullRequestReview(value: unknown): PullRequestReview {
  const user = isRecord(value) ? value.user : undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.state !== "string" ||
    !isRecord(user) ||
    typeof user.login !== "string"
  )
    throw shapeError("GET /repos/{owner}/{repo}/pulls/{n}/reviews");
  return {
    id: String(value.id),
    body: typeof value.body === "string" ? value.body : "",
    authorLogin: user.login,
    state: value.state,
  };
}

/** The body of a create or update of a check run, in GitHub's field names. */
function checkRunBody(input: Partial<NewCheckRun>): Record<string, unknown> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.headSha === undefined ? {} : { head_sha: input.headSha }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.conclusion === undefined ? {} : { conclusion: input.conclusion }),
    ...(input.externalId === undefined
      ? {}
      : { external_id: input.externalId }),
    ...(input.detailsUrl === undefined
      ? {}
      : { details_url: input.detailsUrl }),
    ...(input.startedAt === undefined ? {} : { started_at: input.startedAt }),
    ...(input.completedAt === undefined
      ? {}
      : { completed_at: input.completedAt }),
    ...(input.output === undefined ? {} : { output: input.output }),
  };
}

function checkCommitSha(sha: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "The commit is not a full lower case sha.",
    );
}

function checkCheckRunId(id: string): void {
  if (!/^[1-9]\d{0,15}$/.test(id))
    throw new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "The check run id is not a number.",
    );
}

function checkInstallationId(installationId: string): void {
  if (!/^\d+$/.test(installationId))
    throw new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "The installation id is not a number.",
    );
}

/** A path segment must be a real name: `.` and `..` would make the URL point somewhere else. */
function isPlainSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== "..";
}

function repoPath(repoFullName: string): string {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(repoFullName);
  const owner = match?.[1];
  const name = match?.[2];
  if (
    owner === undefined ||
    name === undefined ||
    !isPlainSegment(owner) ||
    !isPlainSegment(name)
  )
    throw new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "The repository name is not in the form owner/name.",
    );
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/**
 * GitHub's words for a refusal as one short line: control characters become spaces, a link and a token-looking word are replaced
 * (the text is GitHub's, but it can quote what was sent), and the rest is cut at `REASON_MAX_CHARS`. Undefined for nothing.
 */
function cleanReason(text: string): string | undefined {
  const line = text
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/https?:\/\/\S*/gi, "[link]")
    .replace(/\b(?:gh[pousr]_|github_pat_)\w+/g, "[token]")
    .replace(/ {2,}/g, " ")
    .trim();
  if (line === "") return undefined;
  if (line.length <= REASON_MAX_CHARS) return line;
  const cut = line.slice(0, REASON_MAX_CHARS - 1);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

/** A name with a half of a surrogate pair cannot be percent encoded (`encodeURIComponent` throws a URIError). */
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether `json` is a pull request from `input.head` of the repository itself into `input.base`. */
function isPullRequestOf(
  json: unknown,
  repoFullName: string,
  input: NewPullRequest,
): boolean {
  if (!isRecord(json) || !isRecord(json.head) || !isRecord(json.base))
    return false;
  const { repo } = json.head;
  return (
    json.head.ref === input.head &&
    json.base.ref === input.base &&
    isRecord(repo) &&
    typeof repo.full_name === "string" &&
    repo.full_name.toLowerCase() === repoFullName.toLowerCase()
  );
}

/**
 * A label name goes into a path (`DELETE .../labels/{name}`): `.` and `..` (and any name of dots only) are dot segments there, and
 * `.../labels/.` is normalised to `.../labels/`, which removes every label of the issue.
 */
function checkLabelName(name: string): void {
  if (
    name === "" ||
    /^\.+$/.test(name) ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    UNPAIRED_SURROGATE.test(name)
  )
    throw new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "The label name is not usable.",
    );
}

/**
 * A branch name is text without control characters or lone surrogates; Git allows no more than 255 bytes in a
 * ref component. `.` and `..` are no branches either: in a path they are dot segments and would address a
 * different endpoint.
 */
function checkBranchName(name: string): void {
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    UNPAIRED_SURROGATE.test(name)
  )
    throw new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "The branch name is not usable.",
    );
}

function checkPullRequestNumber(prNumber: number): void {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1)
    throw new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "The pull request number is not a positive whole number.",
    );
}

const PERMISSION_LEVELS = ["read", "write", "admin"];

/**
 * GitHub echoes what a token really holds, and this check is the last defence behind "never
 * broader": it fails closed. The answer must say the token is limited to selected repositories, list
 * only repositories that were asked for, and list permissions with known levels that are none of
 * them above what was asked for. A missing field, an unknown permission or an unknown level fails.
 */
function isNoBroaderThan(
  json: Record<string, unknown>,
  scope: JobTokenScope,
): boolean {
  if (json.repository_selection !== "selected") return false;
  if (!Array.isArray(json.repositories)) return false;
  for (const repo of json.repositories)
    if (
      !isRecord(repo) ||
      !scope.repositoryIds.some((wanted) => wanted === repo.id)
    )
      return false;
  if (!isRecord(json.permissions)) return false;
  for (const [name, level] of Object.entries(json.permissions)) {
    const asked = scope.permissions[name];
    const held = PERMISSION_LEVELS.indexOf(String(level));
    if (asked === undefined || held === -1) return false;
    if (held > PERMISSION_LEVELS.indexOf(asked)) return false;
  }
  return true;
}

export function createGithubAppClient(
  options: GithubAppClientOptions,
): GithubAppClient {
  const { config } = options;
  const now = options.now ?? Date.now;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const revokeTimeoutMs = options.revokeTimeoutMs ?? DEFAULT_REVOKE_TIMEOUT_MS;
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const doFetch: typeof fetch = (input, init) =>
    (options.fetch ?? globalThis.fetch)(input, init);
  const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();

  // One JWT serves many calls (a listing needs one per page): keep it until shortly before it ends.
  let cachedJwt: { jwt: string; reuseUntilMs: number } | undefined;
  function appJwt(): string {
    const nowMs = now();
    if (cachedJwt && nowMs < cachedJwt.reuseUntilMs) return cachedJwt.jwt;
    const jwt = createAppJwt({
      appId: config.appId,
      privateKey: config.privateKey,
      nowMs,
    });
    cachedJwt = { jwt, reuseUntilMs: nowMs + JWT_REUSE_MS };
    return jwt;
  }

  /** Seconds to wait as the platform said (never negative), or null when it did not say. */
  function retryAfter(headers: Headers): number | null {
    const direct = headers.get("retry-after")?.trim();
    if (
      direct !== undefined &&
      direct !== "" &&
      Number.isFinite(Number(direct))
    )
      return Math.max(0, Number(direct));
    const reset = headers.get("x-ratelimit-reset")?.trim();
    if (reset !== undefined && reset !== "" && Number.isFinite(Number(reset)))
      return Math.max(0, Math.ceil(Number(reset) - now() / 1000));
    return null;
  }

  /**
   * Why GitHub refused, from the `message` and `errors` of its answer (read at most a few kilobytes): the closed set of
   * `GithubRefusalReason`, which only the answers where the reason decides what the caller does need, and `reason`, GitHub's own
   * short words for it (#913). An entry of `errors` without a `message` is named by its `resource`, `field` and `code`
   * (`PullRequest head invalid`: GitHub says that for a branch it cannot resolve, and nothing else).
   */
  async function refusalOf(
    response: Response,
  ): Promise<{ refusal: GithubRefusalReason; reason?: string }> {
    let message = "";
    let entries = "";
    try {
      const json: unknown = JSON.parse((await response.text()).slice(0, 4000));
      if (isRecord(json) && typeof json.message === "string")
        message = json.message;
      // A 422 says what is wrong in `errors` (opening a pull request: the pull request exists, there is nothing to compare).
      if (isRecord(json) && Array.isArray(json.errors))
        entries = json.errors
          .map((entry: unknown) => {
            if (!isRecord(entry)) return "";
            if (typeof entry.message === "string" && entry.message !== "")
              return entry.message;
            return [entry.resource, entry.field, entry.code]
              .filter((part): part is string => typeof part === "string")
              .join(" ");
          })
          .filter((text) => text !== "")
          .join("; ");
    } catch {
      // An answer that is not JSON says nothing.
    }
    const reason = cleanReason(entries === "" ? message : entries);
    return {
      refusal: classify(response.status, `${message} ${entries}`),
      ...(reason === undefined ? {} : { reason }),
    };
  }

  function classify(status: number, message: string): GithubRefusalReason {
    // GitHub's secondary rate limit is a 403 with no header that says so, only its message.
    if ((status === 403 || status === 429) && /rate limit/i.test(message))
      return "rate_limited";
    if (/pull request already exists/i.test(message))
      return "pull_request_exists";
    if (/no commits between/i.test(message)) return "no_commits_between";
    if (/archived/i.test(message)) return "repository_archived";
    if (
      /resource not accessible by integration|permissions? .*not granted/i.test(
        message,
      )
    )
      return "permission_missing";
    if (/repositor(y|ies).*(not exist|not accessible|not found)/i.test(message))
      return "repository_not_accessible";
    return "other";
  }

  function errorForStatus(
    method: string,
    path: string,
    response: Response,
    refusal?: GithubRefusalReason,
    reason?: string,
  ): GithubAppError {
    const status = response.status;
    const call = `${method} ${path}`;
    const rateLimited =
      status === 429 ||
      (status === 403 &&
        (response.headers.get("retry-after") !== null ||
          response.headers.get("x-ratelimit-remaining") === "0" ||
          refusal === "rate_limited"));
    if (rateLimited)
      return new GithubAppError(
        "GITHUB_APP_RATE_LIMITED",
        `GitHub rate limit reached for ${call}.`,
        { status, retryAfterSeconds: retryAfter(response.headers) },
      );
    const code =
      status === 401
        ? "GITHUB_APP_AUTH_FAILED"
        : status === 403
          ? "GITHUB_APP_FORBIDDEN"
          : status === 404
            ? "GITHUB_APP_NOT_FOUND"
            : status >= 500
              ? "GITHUB_APP_UNAVAILABLE"
              : "GITHUB_APP_REQUEST_FAILED";
    return new GithubAppError(code, `GitHub answered ${status} for ${call}.`, {
      status,
      ...(refusal === undefined ? {} : { refusal }),
      // GitHub's words are kept for a refused call (422) only: a refused token request or a 403 has a message of its own.
      ...(reason === undefined || status !== 422 ? {} : { reason }),
      // A 5xx may say when to come back (Retry-After); everything else has nothing to wait for.
      retryAfterSeconds: status >= 500 ? retryAfter(response.headers) : null,
    });
  }

  async function request(
    credential: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    // The client's own timeout always applies; the caller's signal can only end the request sooner.
    const requestSignal =
      signal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      response = await doFetch(`${config.apiBaseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${credential}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": GITHUB_API_VERSION,
          "user-agent": `code-reviewer-${config.slug}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
      });
    } catch {
      // The cause is dropped on purpose: it can quote the request.
      throw new GithubAppError(
        "GITHUB_APP_UNAVAILABLE",
        `GitHub could not be reached for ${method} ${path.split("?")[0]}.`,
      );
    }
    if (!response.ok) {
      const rateLimited =
        response.status === 429 ||
        response.headers.get("retry-after") !== null ||
        response.headers.get("x-ratelimit-remaining") === "0";
      // The body is read only to tell why a 403 or a 422 was refused (#405) and never ends up in a message;
      // otherwise it is not needed: free the socket.
      const refused =
        (response.status === 403 || response.status === 422) && !rateLimited
          ? await refusalOf(response)
          : undefined;
      if (refused === undefined)
        await response.body?.cancel().catch(() => undefined);
      throw errorForStatus(
        method,
        path.split("?")[0] as string,
        response,
        refused?.refusal,
        refused?.reason,
      );
    }
    try {
      return await response.json();
    } catch {
      // Cut off while the body was read (the caller's signal or the timeout): the answer is missing,
      // not malformed.
      if (requestSignal.aborted)
        throw new GithubAppError(
          "GITHUB_APP_UNAVAILABLE",
          `GitHub could not be reached for ${method} ${path.split("?")[0]}.`,
        );
      throw shapeError(`${method} ${path.split("?")[0]}`);
    }
  }

  async function allPages<T>(
    credential: () => Promise<string>,
    path: string,
    pick: (json: unknown) => unknown[],
    map: (item: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const items: T[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const json = await request(
        await credential(),
        "GET",
        `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`,
        undefined,
        signal,
      );
      const batch = pick(json);
      items.push(...batch.map(map));
      if (batch.length < PAGE_SIZE) return items;
    }
    throw new GithubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      `GitHub listed more than ${MAX_PAGES * PAGE_SIZE} items for ${path.split("?")[0]}.`,
    );
  }

  /**
   * `DELETE /installation/token` for a token that must not be used. Never rejects; answers whether the token is off (see the
   * client type). The mint paths ignore the answer (the original failure is what their caller needs to hear about).
   */
  async function revokeInstallationToken(token: string): Promise<boolean> {
    try {
      const response = await doFetch(
        `${config.apiBaseUrl}/installation/token`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": GITHUB_API_VERSION,
            "user-agent": `code-reviewer-${config.slug}`,
          },
          signal: AbortSignal.timeout(revokeTimeoutMs),
        },
      );
      await response.body?.cancel().catch(() => undefined);
      return response.ok || response.status === 401;
    } catch {
      return false;
    }
  }

  /** `default_branch` of `GET /repos/{owner}/{repo}`. */
  async function readDefaultBranch(
    token: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const json = await request(token, "GET", path, undefined, signal);
    if (
      !isRecord(json) ||
      typeof json.default_branch !== "string" ||
      json.default_branch === ""
    )
      throw shapeError("GET /repos/{owner}/{repo}");
    return json.default_branch;
  }

  /** Read calls: a token with everything the app is granted on the whole installation. */
  async function mint(
    installationId: string,
    scope?: JobTokenScope,
    signal?: AbortSignal,
  ): Promise<InstallationToken> {
    checkInstallationId(installationId);
    let json: unknown;
    try {
      json = await request(
        appJwt(),
        "POST",
        `/app/installations/${installationId}/access_tokens`,
        scope === undefined
          ? undefined
          : {
              repository_ids: [...scope.repositoryIds],
              permissions: { ...scope.permissions },
            },
        signal,
      );
    } catch (error) {
      // Same code and message; only marked as the answer to the token request.
      if (error instanceof GithubAppError)
        throw new GithubAppError(error.code, error.message, {
          status: error.status,
          retryAfterSeconds: error.retryAfterSeconds,
          duringTokenRequest: true,
          ...(error.refusal === undefined ? {} : { refusal: error.refusal }),
        });
      throw error;
    }
    if (
      !isRecord(json) ||
      typeof json.token !== "string" ||
      json.token === "" ||
      typeof json.expires_at !== "string" ||
      Number.isNaN(Date.parse(json.expires_at))
    )
      throw shapeError("POST /app/installations/{id}/access_tokens");
    if (scope !== undefined && !isNoBroaderThan(json, scope)) {
      // The token exists and works for up to an hour: switch it off before reporting the failure.
      await revokeInstallationToken(json.token);
      throw new GithubAppError(
        "GITHUB_APP_REQUEST_FAILED",
        "GitHub issued a token broader than the one asked for; it was discarded.",
      );
    }
    return {
      token: json.token,
      expiresAt: new Date(Date.parse(json.expires_at)).toISOString(),
    };
  }

  async function cachedToken(
    installationId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAtMs - now() > TOKEN_EXPIRY_BUFFER_MS)
      return cached.token;
    const minted = await mint(installationId, undefined, signal);
    tokenCache.set(installationId, {
      token: minted.token,
      expiresAtMs: Date.parse(minted.expiresAt),
    });
    return minted.token;
  }

  /** Runs a read with the installation's cached token; one retry with a fresh one if GitHub refuses it. */
  async function withInstallationToken<T>(
    installationId: string,
    run: (token: () => Promise<string>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await run(() => cachedToken(installationId, signal));
    } catch (error) {
      if (
        !(error instanceof GithubAppError) ||
        error.code !== "GITHUB_APP_AUTH_FAILED" ||
        !tokenCache.has(installationId)
      )
        throw error;
      tokenCache.delete(installationId);
      return run(() => cachedToken(installationId, signal));
    }
  }

  /**
   * Runs a call with a token of its own, limited to `scope`, and switches the token off afterwards (best
   * effort, also when the call failed): a notice is the only caller, so no token outlives the post.
   */
  async function withScopedToken<T>(
    installationId: string,
    scope: JobTokenScope,
    run: (token: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const minted = await mint(installationId, scope, signal);
    try {
      return await run(minted.token);
    } finally {
      // The token is always switched off, but once the time of the caller is over nobody waits for the answer.
      if (signal?.aborted === true) void revokeInstallationToken(minted.token);
      else await revokeInstallationToken(minted.token);
    }
  }

  return {
    async getApp() {
      const json = await request(appJwt(), "GET", "/app");
      if (
        !isRecord(json) ||
        typeof json.id !== "number" ||
        typeof json.slug !== "string"
      )
        throw shapeError("GET /app");
      const permissions: Record<string, string> = {};
      if (isRecord(json.permissions))
        for (const [name, level] of Object.entries(json.permissions))
          if (typeof level === "string") permissions[name] = level;
      const owner = json.owner;
      return {
        id: String(json.id),
        slug: json.slug,
        owner:
          isRecord(owner) &&
          typeof owner.id === "number" &&
          typeof owner.login === "string"
            ? { id: owner.id, login: owner.login }
            : null,
        permissions,
      };
    },

    listInstallations() {
      return allPages(
        async () => appJwt(),
        "/app/installations",
        (json) => {
          if (!Array.isArray(json)) throw shapeError("GET /app/installations");
          return json;
        },
        (item) => toInstallation(item, "GET /app/installations"),
      ).then((items) =>
        items.flatMap((item) => {
          if (!("skip" in item)) return [item];
          warn(`[github-app] skipped ${item.skip}.`);
          return [];
        }),
      );
    },

    async getInstallation(installationId) {
      checkInstallationId(installationId);
      try {
        const json = await request(
          appJwt(),
          "GET",
          `/app/installations/${installationId}`,
        );
        const installation = toInstallation(
          json,
          "GET /app/installations/{id}",
        );
        // Unlike a listing, a single lookup cannot skip: the caller asked for exactly this one.
        if ("skip" in installation)
          throw shapeError("GET /app/installations/{id}");
        return installation;
      } catch (error) {
        if (
          error instanceof GithubAppError &&
          error.code === "GITHUB_APP_NOT_FOUND"
        )
          return null;
        throw error;
      }
    },

    async listInstallationRepositories(installationId) {
      checkInstallationId(installationId);
      return withInstallationToken(installationId, async (token) => {
        let total: number | undefined;
        const repositories = await allPages(
          token,
          "/installation/repositories",
          (json) => {
            if (!isRecord(json) || !Array.isArray(json.repositories))
              throw shapeError("GET /installation/repositories");
            total =
              typeof json.total_count === "number" ? json.total_count : total;
            return json.repositories;
          },
          (item) => toRepository(item, "GET /installation/repositories"),
        );
        // Pages are read one after the other while repositories may be added or removed, which can
        // make a page boundary skip one. A list shorter than GitHub's own count is incomplete, and
        // an incomplete list must never be taken for "the others are gone".
        const distinct = new Set(repositories.map((repo) => repo.externalId));
        if (total !== undefined && distinct.size < total)
          throw new GithubAppError(
            "GITHUB_APP_UNAVAILABLE",
            `GitHub listed ${distinct.size} of ${total} repositories; try again.`,
          );
        return repositories;
      });
    },

    async getPullRequest(installationId, repoFullName, prNumber, signal) {
      checkInstallationId(installationId);
      checkPullRequestNumber(prNumber);
      const path = `${repoPath(repoFullName)}/pulls/${prNumber}`;
      return withInstallationToken(
        installationId,
        async (token) => {
          const json = await request(
            await token(),
            "GET",
            path,
            undefined,
            signal,
          );
          const pr = toPullRequestRef(json);
          if (pr === null)
            throw shapeError("GET /repos/{owner}/{repo}/pulls/{n}");
          return pr;
        },
        signal,
      );
    },

    async listOpenPullRequests(installationId, repoFullName, signal) {
      checkInstallationId(installationId);
      return withInstallationToken(
        installationId,
        (token) =>
          allPages(
            token,
            `${repoPath(repoFullName)}/pulls?state=open`,
            (json) => {
              if (!Array.isArray(json))
                throw shapeError("GET /repos/{owner}/{repo}/pulls");
              return json;
            },
            (item) => {
              const pr = toPullRequestRef(item);
              if (pr === null)
                throw shapeError("GET /repos/{owner}/{repo}/pulls");
              return pr;
            },
            signal,
          ),
        signal,
      );
    },

    async getRepositoryFacts(installationId, scope, repoFullName, signal) {
      checkInstallationId(installationId);
      const path = repoPath(repoFullName);
      return withScopedToken(
        installationId,
        scope,
        async (token) => ({
          defaultBranch: await readDefaultBranch(token, path, signal),
        }),
        signal,
      );
    },

    async listBranches(installationId, scope, repoFullName, signal) {
      checkInstallationId(installationId);
      const path = repoPath(repoFullName);
      return withScopedToken(
        installationId,
        scope,
        async (token) => {
          const defaultBranch = await readDefaultBranch(token, path, signal);
          const page = async (number: number): Promise<string[]> => {
            const json = await request(
              token,
              "GET",
              `${path}/branches?per_page=${BRANCH_LIST_LIMIT}&page=${number}`,
              undefined,
              signal,
            );
            if (!Array.isArray(json))
              throw shapeError("GET /repos/{owner}/{repo}/branches");
            return json.map((item: unknown) => {
              if (!isRecord(item) || typeof item.name !== "string")
                throw shapeError("GET /repos/{owner}/{repo}/branches");
              return item.name;
            });
          };
          const first = await page(1);
          // A full page may be all there is: only a second page tells.
          const more =
            first.length === BRANCH_LIST_LIMIT && (await page(2)).length > 0;
          const all = [
            defaultBranch,
            ...first.filter((name) => name !== defaultBranch),
          ];
          return {
            names: all.slice(0, BRANCH_LIST_LIMIT),
            truncated: more || all.length > BRANCH_LIST_LIMIT,
          };
        },
        signal,
      );
    },

    async getBranch(installationId, scope, repoFullName, name, signal) {
      checkInstallationId(installationId);
      checkBranchName(name);
      const path = `${repoPath(repoFullName)}/branches/${encodeURIComponent(name)}`;
      return withScopedToken(
        installationId,
        scope,
        async (token) => {
          try {
            const json = await request(token, "GET", path, undefined, signal);
            const commit = isRecord(json) ? json.commit : undefined;
            if (
              !isRecord(commit) ||
              typeof commit.sha !== "string" ||
              commit.sha === ""
            )
              throw shapeError("GET /repos/{owner}/{repo}/branches/{branch}");
            return { sha: commit.sha };
          } catch (error) {
            if (
              error instanceof GithubAppError &&
              error.code === "GITHUB_APP_NOT_FOUND"
            )
              return null;
            throw error;
          }
        },
        signal,
      );
    },

    async getCollaboratorPermission(installationId, repoFullName, login) {
      checkInstallationId(installationId);
      if (!isPlainSegment(login))
        throw new GithubAppError(
          "GITHUB_APP_REQUEST_FAILED",
          "The login is not a usable user name.",
        );
      const path = `${repoPath(repoFullName)}/collaborators/${encodeURIComponent(login)}/permission`;
      return withInstallationToken(installationId, async (token) => {
        try {
          const json = await request(await token(), "GET", path);
          const permission = isRecord(json) ? json.permission : undefined;
          if (
            permission === "admin" ||
            permission === "write" ||
            permission === "read" ||
            permission === "none"
          )
            return permission;
          throw shapeError(
            "GET /repos/{owner}/{repo}/collaborators/{user}/permission",
          );
        } catch (error) {
          // GitHub answers 404 for a login it does not know: that user has no access.
          if (
            error instanceof GithubAppError &&
            error.code === "GITHUB_APP_NOT_FOUND"
          )
            return "none" as const;
          throw error;
        }
      });
    },

    async listIssueComments(
      installationId,
      scope,
      repoFullName,
      prNumber,
      options = {},
    ) {
      checkInstallationId(installationId);
      checkPullRequestNumber(prNumber);
      const since =
        options.since === undefined
          ? ""
          : `?since=${encodeURIComponent(options.since)}`;
      const path = `${repoPath(repoFullName)}/issues/${prNumber}/comments${since}`;
      return withScopedToken(
        installationId,
        scope,
        (token) =>
          allPages(
            async () => token,
            path,
            (json) => {
              if (!Array.isArray(json))
                throw shapeError(
                  "GET /repos/{owner}/{repo}/issues/{n}/comments",
                );
              return json;
            },
            (item) => toIssueComment(item),
            options.signal,
          ),
        options.signal,
      );
    },

    async getIssueComment(
      installationId,
      scope,
      repoFullName,
      commentId,
      signal,
    ) {
      checkInstallationId(installationId);
      checkCheckRunId(commentId);
      const path = `${repoPath(repoFullName)}/issues/comments/${commentId}`;
      return withScopedToken(
        installationId,
        scope,
        async (token) => {
          try {
            const value = await request(token, "GET", path, undefined, signal);
            return {
              ...toIssueComment(
                value,
                "GET /repos/{owner}/{repo}/issues/comments/{id}",
              ),
              below: isRecord(value) ? commentTarget(value) : null,
            };
          } catch (error) {
            if (
              error instanceof GithubAppError &&
              error.code === "GITHUB_APP_NOT_FOUND"
            )
              return null;
            throw error;
          }
        },
        signal,
      );
    },

    async createIssueComment(
      installationId,
      scope,
      repoFullName,
      prNumber,
      body,
      signal,
    ) {
      checkInstallationId(installationId);
      checkPullRequestNumber(prNumber);
      const path = `${repoPath(repoFullName)}/issues/${prNumber}/comments`;
      return withScopedToken(
        installationId,
        scope,
        async (token) => {
          const json = await request(token, "POST", path, { body }, signal);
          if (
            !isRecord(json) ||
            typeof json.id !== "number" ||
            typeof json.html_url !== "string"
          )
            throw shapeError("POST /repos/{owner}/{repo}/issues/{n}/comments");
          return { id: String(json.id), url: json.html_url };
        },
        signal,
      );
    },

    async openPullRequest(installationId, scope, repoFullName, input, signal) {
      checkInstallationId(installationId);
      checkBranchName(input.head);
      checkBranchName(input.base);
      const path = `${repoPath(repoFullName)}/pulls`;
      const owner = repoFullName.split("/")[0] as string;
      const lookup = `${path}?state=open&head=${encodeURIComponent(`${owner}:${input.head}`)}&base=${encodeURIComponent(input.base)}`;
      const toOpened = (
        json: unknown,
        existing: boolean,
      ): OpenedPullRequest => {
        const pr = toPullRequestRef(json);
        if (pr === null) throw shapeError("POST /repos/{owner}/{repo}/pulls");
        return { number: pr.number, url: pr.url, existing };
      };
      return withScopedToken(
        installationId,
        scope,
        async (token) => {
          const found = async (): Promise<OpenedPullRequest | null> => {
            const json = await request(token, "GET", lookup, undefined, signal);
            if (!Array.isArray(json))
              throw shapeError("GET /repos/{owner}/{repo}/pulls");
            // The head and the base are the ones asked for, and the head is a branch of this repository: `owner:branch` also names
            // a branch of a fork of the same owner.
            const first = json.find((entry: unknown) =>
              isPullRequestOf(entry, repoFullName, input),
            );
            return first === undefined ? null : toOpened(first, true);
          };
          const before = await found();
          if (before !== null) return before;
          try {
            return toOpened(
              await request(
                token,
                "POST",
                path,
                {
                  head: input.head,
                  base: input.base,
                  title: input.title,
                  ...(input.body === undefined ? {} : { body: input.body }),
                  ...(input.draft === undefined ? {} : { draft: input.draft }),
                },
                signal,
              ),
              false,
            );
          } catch (error) {
            // Somebody opened it between the look and the call.
            if (
              !(error instanceof GithubAppError) ||
              error.refusal !== "pull_request_exists"
            )
              throw error;
            const raced = await found();
            if (raced === null) throw error;
            return raced;
          }
        },
        signal,
      );
    },

    async changeIssueLabels(
      installationId,
      scope,
      repoFullName,
      issueNumber,
      change,
      signal,
    ) {
      checkInstallationId(installationId);
      checkPullRequestNumber(issueNumber);
      for (const name of [...change.add, ...change.remove])
        checkLabelName(name);
      const path = `${repoPath(repoFullName)}/issues/${issueNumber}/labels`;
      return withScopedToken(
        installationId,
        scope,
        async (token) => {
          const labelsOf = async (): Promise<string[]> => {
            const names: string[] = [];
            for (let page = 1; page <= MAX_PAGES; page += 1) {
              const json = await request(
                token,
                "GET",
                `${path}?per_page=${PAGE_SIZE}&page=${page}`,
                undefined,
                signal,
              );
              if (!Array.isArray(json))
                throw shapeError("GET /repos/{owner}/{repo}/issues/{n}/labels");
              for (const item of json) {
                if (!isRecord(item) || typeof item.name !== "string")
                  throw shapeError(
                    "GET /repos/{owner}/{repo}/issues/{n}/labels",
                  );
                names.push(item.name);
              }
              if (json.length < PAGE_SIZE) return names;
            }
            throw new GithubAppError(
              "GITHUB_APP_REQUEST_FAILED",
              "GitHub listed more labels than the app reads.",
            );
          };
          // The first read is also what tells a missing issue (404) from a label that is not on it.
          const present = await labelsOf();
          const toAdd = change.add.filter((name) => !present.includes(name));
          if (toAdd.length > 0)
            await request(token, "POST", path, { labels: toAdd }, signal);
          for (const name of change.remove) {
            if (!present.includes(name)) continue;
            try {
              await request(
                token,
                "DELETE",
                `${path}/${encodeURIComponent(name)}`,
                undefined,
                signal,
              );
            } catch (error) {
              // Gone since the read.
              if (
                !(error instanceof GithubAppError) ||
                error.code !== "GITHUB_APP_NOT_FOUND"
              )
                throw error;
            }
          }
          return toAdd.length === 0 &&
            change.remove.every((name) => !present.includes(name))
            ? present
            : labelsOf();
        },
        signal,
      );
    },

    async createCheckRun(installationId, scope, repoFullName, input, signal) {
      checkInstallationId(installationId);
      checkCommitSha(input.headSha);
      const path = `${repoPath(repoFullName)}/check-runs`;
      return withScopedToken(
        installationId,
        scope,
        async (token) => {
          const json = await request(
            token,
            "POST",
            path,
            checkRunBody(input),
            signal,
          );
          if (!isRecord(json) || typeof json.id !== "number")
            throw shapeError("POST /repos/{owner}/{repo}/check-runs");
          return { id: String(json.id) };
        },
        signal,
      );
    },

    async updateCheckRun(
      installationId,
      scope,
      repoFullName,
      checkRunId,
      input,
      signal,
    ) {
      checkInstallationId(installationId);
      checkCheckRunId(checkRunId);
      const path = `${repoPath(repoFullName)}/check-runs/${checkRunId}`;
      await withScopedToken(
        installationId,
        scope,
        async (token) => {
          await request(token, "PATCH", path, checkRunBody(input), signal);
        },
        signal,
      );
    },

    async findCheckRun(installationId, scope, repoFullName, lookup, signal) {
      checkInstallationId(installationId);
      checkCommitSha(lookup.headSha);
      const path = `${repoPath(repoFullName)}/commits/${lookup.headSha}/check-runs?check_name=${encodeURIComponent(lookup.name)}&filter=all`;
      return withScopedToken(
        installationId,
        scope,
        async (token) => {
          const runs = await allPages(
            async () => token,
            path,
            (json) => {
              if (!isRecord(json) || !Array.isArray(json.check_runs))
                throw shapeError(
                  "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
                );
              return json.check_runs;
            },
            (item) => ({
              id: isRecord(item) ? item.id : undefined,
              externalId: isRecord(item) ? item.external_id : undefined,
            }),
            signal,
          );
          const found = runs.find(
            (run) =>
              typeof run.id === "number" &&
              run.externalId === lookup.externalId,
          );
          return found === undefined ? null : { id: String(found.id) };
        },
        signal,
      );
    },

    async createPullRequestReview(
      installationId,
      scope,
      repoFullName,
      prNumber,
      input,
      signal,
    ) {
      checkInstallationId(installationId);
      checkPullRequestNumber(prNumber);
      checkCommitSha(input.commitId);
      const path = `${repoPath(repoFullName)}/pulls/${prNumber}/reviews`;
      return withScopedToken(
        installationId,
        scope,
        async (token) => {
          const json = await request(
            token,
            "POST",
            path,
            {
              commit_id: input.commitId,
              body: input.body,
              event: input.event,
            },
            signal,
          );
          if (!isRecord(json) || typeof json.id !== "number")
            throw shapeError("POST /repos/{owner}/{repo}/pulls/{n}/reviews");
          return { id: String(json.id) };
        },
        signal,
      );
    },

    async listPullRequestReviews(
      installationId,
      scope,
      repoFullName,
      prNumber,
      signal,
    ) {
      checkInstallationId(installationId);
      checkPullRequestNumber(prNumber);
      const path = `${repoPath(repoFullName)}/pulls/${prNumber}/reviews`;
      return withScopedToken(
        installationId,
        scope,
        (token) =>
          allPages(
            async () => token,
            path,
            (json) => {
              if (!Array.isArray(json))
                throw shapeError("GET /repos/{owner}/{repo}/pulls/{n}/reviews");
              return json;
            },
            (item) => toPullRequestReview(item),
            signal,
          ),
        signal,
      );
    },

    async dismissPullRequestReview(
      installationId,
      scope,
      repoFullName,
      prNumber,
      reviewId,
      message,
      signal,
    ) {
      checkInstallationId(installationId);
      checkPullRequestNumber(prNumber);
      checkCheckRunId(reviewId);
      const path = `${repoPath(repoFullName)}/pulls/${prNumber}/reviews/${reviewId}/dismissals`;
      await withScopedToken(
        installationId,
        scope,
        async (token) => {
          await request(
            token,
            "PUT",
            path,
            { message, event: "DISMISS" },
            signal,
          );
        },
        signal,
      );
    },

    revokeInstallationToken,

    async mintInstallationToken(installationId, scope) {
      if (scope.repositoryIds.length === 0)
        throw new GithubAppError(
          "GITHUB_APP_REQUEST_FAILED",
          "A job token needs at least one repository.",
        );
      if (
        !scope.repositoryIds.every((id) => Number.isSafeInteger(id) && id > 0)
      )
        throw new GithubAppError(
          "GITHUB_APP_REQUEST_FAILED",
          "A repository id is not a positive whole number.",
        );
      if (Object.keys(scope.permissions).length === 0)
        throw new GithubAppError(
          "GITHUB_APP_REQUEST_FAILED",
          "A job token needs explicit permissions.",
        );
      return mint(installationId, scope);
    },
  };
}
