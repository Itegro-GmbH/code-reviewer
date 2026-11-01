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
   */
  implementerAccess(
    integration: Integration,
    repo: RepoRef,
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
}
