// SPDX-License-Identifier: LicenseRef-Proprietary

// The interface behind which everything platform specific lives. Jobs, the runner API and the UI
// call these methods and see normalized types only. See README.md in this folder.
import type { ConfigValidationResult } from "./config-schema.ts";
import type {
  ConnectionPermissions,
  DiscoveredConnection,
  GitAccess,
  Integration,
  IntegrationEvent,
  IntegrationType,
  PullRequestRef,
  RepoRef,
  ReviewCheck,
  ReviewTrigger,
  ReviewVerdict,
  TrackerChangeResult,
  TrackerPage,
  TrackerPageStep,
} from "./types.ts";

/** How a user connects this kind of integration. */
export const CONNECT_FLOW_KINDS = [
  "install_redirect",
  "oauth",
  "token_form",
] as const;
export type ConnectFlow = { kind: (typeof CONNECT_FLOW_KINDS)[number] };

export interface IntegrationProvider {
  readonly type: IntegrationType;
  readonly connect: ConnectFlow;

  /** Checks a config from the user or the platform. One error per offending field. */
  validateConfig(config: unknown): ConfigValidationResult;

  /**
   * Only where the platform can list the connections of this app (GitHub App: the installations).
   * The sync creates, updates and disables `integrations` rows from it. Rejects when the platform
   * cannot be asked, so a failure is never mistaken for "there are no connections".
   */
  discoverConnections?(): Promise<DiscoveredConnection[]>;

  /**
   * Only together with `discoverConnections`: asks the platform whether one connection exists, and
   * returns its details or null when the platform does not know it. This is how a "connection
   * created" delivery for a connection without a row is verified before a row is created.
   */
  findConnection?(externalId: string): Promise<DiscoveredConnection | null>;

  /**
   * Only where the platform has an account that the app itself belongs to (GitHub App: its owner): the id and
   * the name of that account, as the platform reports them for the app's own credentials, or null when it does
   * not say. A connection on that account is the app's "own" (the single-tenant auto-attach asks).
   */
  ownerAccount?(): Promise<{ externalId: string; login: string } | null>;

  /** Every repository of the connection the app may see. Rejects when it cannot list all of them. */
  listRepositories(integration: Integration): Promise<RepoRef[]>;

  /** Only where webhooks are per repository: creates the webhook if it is missing. */
  ensureWebhook?(integration: Integration, repo: RepoRef): Promise<void>;

  /**
   * Checks the signature of a delivery. `integration` is null for platforms with one shared
   * webhook (GitHub App), where the connection is only known after `identifyWebhook`. Reads a clone
   * of the request: the caller can still read the body afterwards.
   */
  verifyWebhook(
    integration: Integration | null,
    request: Request,
  ): Promise<boolean>;

  /**
   * For a shared webhook: which connection does this delivery belong to? The route calls it after
   * `verifyWebhook(null, request)` and looks the row up by `(type, externalId)`. Returns null where
   * the URL already names the connection or the delivery carries no connection id. Reads a clone,
   * has no side effects.
   */
  identifyWebhook(request: Request): Promise<{ externalId: string } | null>;

  /**
   * Translates a verified delivery into what it means for the app: a review trigger, a change of
   * the connection (installed, removed, repositories changed) or nothing of interest. Reads a clone.
   */
  parseEvent(
    integration: Integration,
    request: Request,
  ): Promise<IntegrationEvent>;

  /**
   * May this trigger start a job? About the trigger only (for example: has the comment author write
   * access), not about the app's own permissions on the platform.
   */
  canTrigger(
    integration: Integration,
    trigger: ReviewTrigger,
  ): Promise<boolean>;

  /**
   * Only where the app can write a comment below a pull request (#281): posts `body` as the app, with a token
   * of its own limited to this repository and to the comment permission (never the credentials of a job). When
   * `lookForEarlierSince` is given, first looks for a comment of the app itself, changed since then, that holds
   * `marker`, and posts nothing if there is one ("already_there"): the way an app instance that is unsure
   * whether another one posted does not post twice. Rejects with an `IntegrationError` with a stable code; the
   * message never holds a token or the body.
   */
  postPullRequestNotice?(
    integration: Integration,
    repo: RepoRef,
    prNumber: number,
    notice: { body: string; marker: string; lookForEarlierSince?: string },
  ): Promise<"posted" | "already_there">;

  /**
   * Only where the app can open a pull request (#844, the workflow action `github.pullRequest.open`): opens one from `head` (a
   * branch of the repository itself) into `base`, as the app, with a token of its own limited to this repository and the pull
   * request permission. A pull request that is open for this head and base is the result (`existing`), not an error. Rejects with
   * an `IntegrationError`: `INTEGRATION_ACCESS_SCOPE_REFUSED` is an app without the permission, `INTEGRATION_REQUEST_REFUSED` a
   * request the platform refuses for its content (no commits between the branches). The message never holds a token or the text.
   */
  openPullRequest?(
    integration: Integration,
    repo: RepoRef,
    input: {
      head: string;
      base: string;
      title: string;
      body?: string;
      draft?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<{ number: number; url: string; existing: boolean }>;

  /**
   * Only where tickets can be read (#916, the `ticket` input of a trigger): one issue of the repository with the fields a workflow reads
   * as `{{trigger.ticket.…}}`, or null when there is no issue of that number (a pull request is none). Read with a token limited to
   * this repository and to reading its issues. The texts are those of whoever opened the issue: untrusted. Rejects like
   * `getRepositoryFacts`.
   */
  readIssue?(
    integration: Integration,
    repo: RepoRef,
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<{
    number: number;
    title: string;
    body: string;
    url: string;
    labels: string[];
    assignees: string[];
    type: string;
  } | null>;

  /**
   * Only where the app can write a comment (#844, `github.issue.comment`): writes `body` below an issue or pull request, as the
   * app, with a token limited to this repository and the issue permission. With a `marker` (text inside `body`), the comments of the
   * issue are looked at first: the app's own comment that holds the marker is the result (`existing`) and nothing is written, so a
   * call that is made again does not comment twice. `since` (ISO 8601) bounds that look to the comments changed after it: nothing older
   * can hold the marker. Rejects like `openPullRequest`.
   */
  commentOnIssue?(
    integration: Integration,
    repo: RepoRef,
    issueNumber: number,
    body: string,
    options?: { signal?: AbortSignal; marker?: string; since?: string },
  ): Promise<{ url: string; existing: boolean; id?: string }>;

  /**
   * Only where the app can edit its own comment (#920): replaces the body of the comment `commentId` below an issue or pull request, with
   * a token limited to this repository and the issue permission. Rejects like `commentOnIssue`; 404 when the comment is gone.
   */
  updateIssueComment?(
    integration: Integration,
    repo: RepoRef,
    commentId: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Only where the app can label (#844, `github.issue.labels`): adds and removes labels of an issue or pull request, as the app,
   * with a token limited to this repository and the issue permission. Idempotent. Answers every label on the issue afterwards.
   * Rejects like `openPullRequest`.
   */
  changeIssueLabels?(
    integration: Integration,
    repo: RepoRef,
    issueNumber: number,
    change: { add: readonly string[]; remove: readonly string[] },
    signal?: AbortSignal,
  ): Promise<{ labels: string[] }>;

  /**
   * Only where the app can ask for a review (#917, `ticket.requestReview`): requests a review of pull request `prNumber` from these users
   * (logins), as the app, with a token limited to this repository and the pull request permission. Answers the users that are asked
   * afterwards. Asking twice is harmless. With `skipRefused`, a user the platform refuses (not a collaborator, the author) is left
   * out instead of failing the call (a refusal for another reason still fails it); `max` stops asking once that many are requested. Rejects like `openPullRequest`; `INTEGRATION_REQUEST_REFUSED` is a user that cannot review.
   */
  requestReviewers?(
    integration: Integration,
    repo: RepoRef,
    prNumber: number,
    reviewers: readonly string[],
    options?: { skipRefused?: boolean; max?: number; signal?: AbortSignal },
  ): Promise<{ requested: string[] }>;

  /**
   * Only where tickets sit on a board (#917, `ticket.setStatus`; GitHub: a Project, projects_v2): puts issue `issueNumber` into the
   * status column named `status` of the board `board` (its number or id) of the repository's owner, adding the issue to the board when
   * it is not on it. The token is limited to this repository and to the projects permission of the app, which the owner of the
   * installation grants on its own (without it the call rejects with `INTEGRATION_ACCESS_SCOPE_REFUSED`). What the board or the issue
   * decide is an answer, not an error. Idempotent.
   */
  setTicketStatus?(
    integration: Integration,
    repo: RepoRef,
    issueNumber: number,
    move: { board: string; status: string },
    signal?: AbortSignal,
  ): Promise<
    | { kind: "moved"; status: string }
    | { kind: "board_not_found" }
    | { kind: "issue_not_found" }
    | { kind: "status_unknown"; available: string[] }
  >;

  /**
   * Only where a review is posted as a comment (#657): the body of the comment `commentId` below the pull request, so the
   * run page can show what was posted. Only a comment the app itself wrote counts (anybody can write a comment): another
   * author's, and a comment that is gone, answer null. The body is untrusted text. Rejects like `getPullRequest`; the
   * message never holds a token or the body.
   */
  readReviewComment?(
    integration: Integration,
    repo: RepoRef,
    commentId: string,
    signal?: AbortSignal,
  ): Promise<{
    body: string;
    /** The repository and pull request the platform says the comment sits below; null when it names none. */
    below: { repoFullName: string; number: number } | null;
  } | null>;

  /**
   * Only where the platform shows the progress of a review next to the pull request (#405; GitHub: a check run):
   * makes the check of the job or, with `known.checkRunId`, changes it, with a token of the app's own limited to
   * this repository and the permission to write checks (never the credentials of a job). `known.mayExist` says an
   * earlier call may have made the check without its id being kept: it is looked for by the job first. Rejects with
   * an `IntegrationError`; `INTEGRATION_ACCESS_SCOPE_REFUSED` is an app that was not granted the permission (an
   * installation that has not accepted it yet). The message never holds a token or a body.
   */
  publishReviewCheck?(
    integration: Integration,
    repo: RepoRef,
    check: ReviewCheck,
    known: {
      checkRunId: string | null;
      mayExist: boolean;
      /**
       * False for a job that ended before its check was ever shown: the check is looked for (an earlier attempt may
       * have made it) and completed if it is there, but none is made. Default true.
       */
      createIfMissing?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<{ checkRunId: string | null }>;

  /**
   * Only where the app can review a pull request (#405): submits the verdict as the app, with a token limited to
   * this repository and the pull request permission. With `lookForEarlier` it first looks for a review of the app
   * itself that holds `verdict.marker` and submits nothing if there is one, the way an instance that is unsure
   * whether another one submitted does not submit twice. Rejects like `publishReviewCheck`;
   * `INTEGRATION_REQUEST_REFUSED` is a review the platform refuses for its content (the app's own pull request).
   */
  submitReviewVerdict?(
    integration: Integration,
    repo: RepoRef,
    prNumber: number,
    verdict: ReviewVerdict,
    options: { lookForEarlier: boolean },
    signal?: AbortSignal,
  ): Promise<{ outcome: "submitted" | "already_there"; reviewId: string }>;

  /**
   * Only where the app can review a pull request (#405): takes back the app's own latest request for changes (the
   * latest review of the app that holds `markerPrefix` and still asks for changes) by dismissing it with `message`.
   * Nothing else is touched: a review of anybody else is never dismissed, whatever its text says. Rejects like
   * `submitReviewVerdict`.
   */
  withdrawReviewVerdict?(
    integration: Integration,
    repo: RepoRef,
    prNumber: number,
    options: { message: string; markerPrefix: string },
    signal?: AbortSignal,
  ): Promise<{
    outcome: "dismissed" | "nothing_to_dismiss";
    reviewId: string | null;
  }>;

  /** Credentials for one job on one repository; short-lived where the platform allows it. */
  jobAccess(integration: Integration, repo: RepoRef): Promise<GitAccess>;

  /**
   * Credentials for one Implementer turn on one repository (#749): like `jobAccess`, a fresh token limited to exactly
   * this repository, but with the right to write its contents (push a branch) and nothing else. Never used by a review
   * job. Rejects with an `IntegrationError` like `jobAccess`; `INTEGRATION_ACCESS_PERMISSION_NOT_GRANTED` says the
   * connection has not accepted the write permission yet (not retryable). It is a capability of its own (#753): a
   * deployment without `implementer` is refused with `INTEGRATION_CAPABILITY_ABSENT` before the platform is asked
   * anything, whatever the App was set to by hand. A token lives up to an hour; `revokeImplementerAccess` ends it.
   * `readOnly` (#843, a turn whose profile may not push): the same token but with the right to read the contents and nothing
   * else, so the turn could not push even with a bug.
   */
  implementerAccess(
    integration: Integration,
    repo: RepoRef,
    options?: { readOnly?: boolean },
  ): Promise<GitAccess>;

  /**
   * Switches off a token `implementerAccess` handed out (#753), so a write token does not outlive its job: called when the
   * token never reached a Worker, and when the turn is over. Idempotent, never rejects, and not behind the capability, because
   * a cleanup is never refused. Answers whether the token is off: `true` when the platform switched it off or says it is not
   * valid any more; `false` when that is not known (an error, a rate limit, no answer in time), and the caller keeps the token and
   * tries again until it expires. `token` is the value `implementerAccess` returned.
   */
  revokeImplementerAccess(
    integration: Integration,
    token: string,
  ): Promise<boolean>;

  /**
   * What the connection has accepted on the platform (#749), so that a page can say "write access not granted" before a
   * task is accepted. Reads the connection, mints no token. Rejects like `jobAccess` (a removed connection is
   * `INTEGRATION_ACCESS_CONNECTION_GONE`).
   */
  installationPermissions(
    integration: Integration,
  ): Promise<ConnectionPermissions>;

  /**
   * One pull request of a repository, for example to start a review by hand. When `signal` fires, the
   * request to the platform is aborted (not just no longer waited for) and the call rejects with
   * `INTEGRATION_ACCESS_UNAVAILABLE`.
   */
  getPullRequest(
    integration: Integration,
    repo: RepoRef,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<PullRequestRef>;

  /**
   * The facts about a repository that the pickers need (#750): its default branch, which is always preselected.
   * Reads with a token limited to this repository and to reading its contents (never the credentials of a job).
   * Rejects like `getPullRequest` with an `IntegrationError`; a repository that is gone or refused is
   * `INTEGRATION_ACCESS_*`. The message never holds a token.
   */
  getRepositoryFacts(
    integration: Integration,
    repo: RepoRef,
    signal?: AbortSignal,
  ): Promise<{ defaultBranch: string }>;

  /**
   * The branch names of a repository for the base branch picker (#750): at most the first 100, the default branch
   * first, and whether there are more. Same token, errors and abort rules as `getRepositoryFacts`.
   */
  listBranches(
    integration: Integration,
    repo: RepoRef,
    signal?: AbortSignal,
  ): Promise<{ names: string[]; truncated: boolean }>;

  /**
   * One branch by name, `feature/x` included (#750): its head commit, or null when the repository has no such
   * branch. This is the `branch_exists` check before anything is enqueued. Same token, errors and abort rules as
   * `getRepositoryFacts`.
   *
   * Null can also mean that the repository path in `repo` is stale (the repository was renamed or moved, so
   * GitHub answers 404 for the branch as well): a caller must call `getRepositoryFacts` first, which rejects when the
   * repository path no longer resolves, and trust a null only after that.
   */
  getBranch(
    integration: Integration,
    repo: RepoRef,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string } | null>;

  /** The open pull requests of a repository (drafts included, marked as such). Aborts like `getPullRequest`. */
  listOpenPullRequests(
    integration: Integration,
    repo: RepoRef,
    signal?: AbortSignal,
  ): Promise<PullRequestRef[]>;

  /**
   * Only where the platform has tickets the app mirrors (#923, the GitHub App): what the delivery says about the ticket mirror. Reads the
   * payload and no more; a delivery that is no news for the mirror is `ignored` with a reason for the log.
   */
  parseTrackerChange?(
    integration: Integration,
    request: Request,
  ): Promise<TrackerChangeResult>;

  /**
   * Only together with `parseTrackerChange`: one page of one phase of a full sync of a repository's tickets (#923), read with a token
   * of its own that holds the read permissions of that phase and nothing else. Rejects when the platform cannot be asked; a board the
   * app may not read is `available: false`, never a failure.
   */
  readTrackerPage?(
    integration: Integration,
    repo: RepoRef,
    step: TrackerPageStep,
    signal?: AbortSignal,
  ): Promise<TrackerPage>;

  /**
   * Only together with `parseTrackerChange`: the status the project boards give a ticket now, by the platform's id of the ticket
   * (#932): the status on the first board that has one, or null when the ticket is on no board or has no status. `boardId` (#937): the
   * platform's id of the board the project chose; then only the item of the ticket on that board counts, whatever the other boards say.
   * `available: false` when the app may not read boards. Rejects when the platform cannot be asked.
   */
  readBoardStatus?(
    integration: Integration,
    repo: RepoRef,
    nodeId: string,
    boardId?: string,
    signal?: AbortSignal,
  ): Promise<{ available: boolean; status: string | null }>;

  /**
   * Only where tickets sit on a board (#922, GitHub: the GitHub Projects, projects_v2, of the repository): the boards a project may take as
   * its own, with the Status field of each and the names of its options, read with a token of its own that holds the read permission of
   * the boards and nothing else. A repository whose boards the app may not read (the Projects permission is missing, the repository
   * belongs to a user) is `available: false`, never a failure; any other failure rejects like the reads of the mirror.
   */
  listBoards?(
    integration: Integration,
    repo: RepoRef,
    signal?: AbortSignal,
  ): Promise<{ available: boolean; boards: BoardInfo[] }>;

  /**
   * Only together with `parseTrackerChange`: the state of the checks of a commit as the platform names it (`success`, `failure`,
   * `in_progress`, ...), or null when it has none. The same rule as the sync uses for each open pull request.
   */
  readChecksState?(
    integration: Integration,
    repo: RepoRef,
    headSha: string,
    signal?: AbortSignal,
  ): Promise<string | null>;
}

/** A board of a repository as the picker of a new project needs it (#922). */
export type BoardInfo = {
  /** The platform's global id of the board. */
  projectV2Id: string;
  /** The number the board has in its owner's list. */
  number: number;
  title: string;
  /** The global id of its Status field; null when it has none (a status cannot be set on such a board). */
  statusFieldId: string | null;
  /** The names of the Status field's options, as the board spells them. */
  statuses: string[];
};
