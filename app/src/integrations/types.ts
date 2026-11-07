// SPDX-License-Identifier: LicenseRef-Proprietary

// The normalized vocabulary of the app. Jobs, the runner API and the UI depend on these types only;
// they never see a GitHub (or any other platform) payload. See README.md in this folder.

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Stable identifiers of the integration kinds that have an implementation. They are stored in the
 * `integrations.type` column, so a value is never renamed or reused.
 *
 * Reserved for later and deliberately NOT in this set (no implementation, no registry entry):
 *   - "github_token"    GitHub with a fine-grained token, one webhook per repository
 *   - "bitbucket_cloud" Bitbucket Cloud with an access token or OAuth
 * Add a value here only together with its provider (see README.md).
 */
export const INTEGRATION_TYPES = ["github_app"] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

/** Documented future types: recognised, but they have no provider yet. */
export const RESERVED_INTEGRATION_TYPES = [
  "github_token",
  "bitbucket_cloud",
] as const;
export type ReservedIntegrationType =
  (typeof RESERVED_INTEGRATION_TYPES)[number];

export function isIntegrationType(value: unknown): value is IntegrationType {
  return INTEGRATION_TYPES.some((type) => type === value);
}

export function isReservedIntegrationType(
  value: unknown,
): value is ReservedIntegrationType {
  return RESERVED_INTEGRATION_TYPES.some((type) => type === value);
}

/**
 * Which secrets a type may keep in its table row. A GitHub App keeps none there: its private key and
 * webhook secret live in the environment of the app. A type that stores credentials adds them here.
 */
export const INTEGRATION_SECRET_STORAGE: Record<
  IntegrationType,
  { credentials: boolean; webhookSecret: boolean }
> = {
  github_app: { credentials: false, webhookSecret: false },
};

/**
 * `active`: in use. `disabled`: suspended or gone on the platform (a full sync resumes it when the platform
 * lists it as active again). `disconnected`: a person of the workspace ended the connection (the installation
 * is still the workspace's, projects and runs are kept); only linking it again from the same workspace
 * brings it back, and the synchronization never touches it.
 */
export const INTEGRATION_STATUSES = [
  "active",
  "disabled",
  "disconnected",
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/** A configured connection to a git platform, as stored in the `integrations` table. */
export type Integration = {
  id: string;
  /** The workspace the connection belongs to (a connection belongs to exactly one). */
  workspaceId: string;
  type: IntegrationType;
  displayName: string;
  /** The platform's id for this connection (GitHub App: the installation id). Never empty. */
  externalId: string;
  /** Non-secret settings of the connection. Never holds a key or a token. */
  config: { [key: string]: JsonValue };
  /** Reserved for token integrations; encrypted later. `null` for a GitHub App. */
  credentials: JsonValue | null;
  /** Only for integrations that get their own webhook secret per connection. */
  webhookSecret: string | null;
  status: IntegrationStatus;
  /** ISO 8601 text in UTC. */
  createdAt: string;
  updatedAt: string;
};

/** A repository on the platform, in terms the rest of the app understands. */
export type RepoRef = {
  integrationId: string;
  /** The platform's id of the repository. */
  externalId: string;
  /** "owner/name". */
  fullName: string;
  /** Web URL of the repository. */
  url: string;
};

/** Why a review was asked for. `command` carries a command and its arguments. */
export const REVIEW_TRIGGER_KINDS = ["opened", "updated", "command"] as const;
export type ReviewTriggerKind = (typeof REVIEW_TRIGGER_KINDS)[number];

/**
 * The commands the product executes today: only `/review` (#203). The same set the runner accepts;
 * a comment that starts with a removed command is an ordinary comment (the parser returns null).
 */
export const REVIEW_COMMANDS = ["review"] as const;
export type ReviewCommand = (typeof REVIEW_COMMANDS)[number];

/**
 * The commands that may still appear in stored history: the queue used to run `/improve`,
 * `/describe` and `/ask`, and their runs stay readable. They are never executable again: no new
 * trigger, enqueue or claim may carry one. The decoder uses this set, so an old row does not throw.
 */
export const STORED_REVIEW_COMMANDS = [
  "review",
  "improve",
  "describe",
  "ask",
] as const;
export type StoredReviewCommand = (typeof STORED_REVIEW_COMMANDS)[number];

export function isStoredReviewCommand(
  value: unknown,
): value is StoredReviewCommand {
  return STORED_REVIEW_COMMANDS.some((command) => command === value);
}

/** An open issue that got a label, as a delivery reports it (#845). The texts are untrusted and not yet bounded. */
export type IssueLabeled = {
  repo: RepoRef;
  /** The default branch of the repository at the time of the delivery. */
  defaultBranch: string;
  issue: {
    number: number;
    title: string;
    /** An issue without a description has an empty body. */
    body: string;
    /** Web URL of the issue. */
    url: string;
    /** The names of all labels the issue has now, the new one included. */
    labels: string[];
  };
  /** The label that was just put on. */
  label: string;
  /** Who put it on. */
  actor: TriggerActor;
};

/** The person or bot that caused the event. */
export type TriggerActor = {
  login: string;
  /** The platform's id of the account, if the event carries it. */
  externalId: string | null;
};

type ReviewTriggerBase = {
  repo: RepoRef;
  prNumber: number;
  /** Web URL of the pull request; building it is platform specific, so the provider does it. */
  prUrl: string;
  headSha: string;
  actor: TriggerActor;
};

/** The state of a pull request as a delivery reports it (merged pull requests are `closed`). */
export const TRIGGER_PULL_REQUEST_STATES = ["open", "closed"] as const;
export type TriggerPullRequestState =
  (typeof TRIGGER_PULL_REQUEST_STATES)[number];

export type ReviewTrigger =
  | (ReviewTriggerBase & {
      kind: "opened" | "updated";
      command: null;
      args: null;
      /** The pull request is a draft (work in progress) when the event happened. */
      draft: boolean;
      /**
       * The state of the pull request in the delivery. A late `synchronize` or `reopened` for a pull
       * request that is closed by now carries `closed`; the automatic trigger policy skips it.
       */
      state: TriggerPullRequestState;
    })
  | (ReviewTriggerBase & {
      kind: "command";
      command: ReviewCommand;
      /**
       * The question of `ask`, already cut to its maximum length; an empty string for the other
       * commands, which take no text. Untrusted: it comes from a comment.
       */
      args: string;
      /**
       * The platform's id of the comment that holds the command. The queue starts at most one job
       * per comment, whatever delivery id the same comment arrives under.
       */
      commentId: string;
    });

/** Git platforms the runner knows how to talk to (the runner maps these to PR-Agent settings). */
export const GIT_PLATFORMS = ["github", "bitbucket", "gitlab"] as const;
export type GitPlatform = (typeof GIT_PLATFORMS)[number];

export const GIT_AUTH_TYPES = ["token", "bearer"] as const;
export type GitAuthType = (typeof GIT_AUTH_TYPES)[number];

/**
 * Short-lived credentials for one job on one repository. Never stored, never logged. Build it with
 * `createGitAccess` (normalized.ts): `token` is then not enumerable, so JSON.stringify, spreading and
 * console output leave it out. Only `revealGitAccess` hands the token out, for the runner API.
 */
export type GitAccess = {
  provider: GitPlatform;
  /** API base URL of the platform. */
  baseUrl: string;
  token: string;
  authType: GitAuthType;
  /** Login the bot acts as, when the platform cannot tell it by itself (GitHub App). */
  botLogin: string | null;
  /** ISO 8601 text in UTC; `null` when the token does not expire. */
  expiresAt: string | null;
};

export const PULL_REQUEST_STATES = ["open", "closed", "merged"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/**
 * The check of a review as the pull request shows it (#405), provider neutral: GitHub renders it as a check run in
 * the checks area. Never red: a conclusion is `success` or `neutral`.
 */
export type ReviewCheck = {
  /** The job: identifies the check among those of the commit, so a check that was made twice can be told. */
  jobId: string;
  headSha: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  /** Required with `completed`. */
  conclusion?: "success" | "neutral";
  title: string;
  summary: string;
  /** Where "details" leads: the review comment. */
  detailsUrl?: string;
};

/** The verdict a finished review leaves on its pull request (#405). The body never holds anything of the pull request. */
export type ReviewVerdict = {
  jobId: string;
  headSha: string;
  event: "approve" | "request_changes";
  /** Short: a verdict line, a link and the marker. */
  body: string;
  /** Hidden text in `body`, by which an earlier review of the app for this job is recognised. */
  marker: string;
};

/** A pull request as the app needs to know it, for example to start a review by hand. */
export type PullRequestRef = {
  number: number;
  title: string;
  url: string;
  headSha: string;
  /** Name of the branch the pull request merges into. */
  baseRef: string;
  /** Name of the branch the changes come from. */
  headRef: string;
  draft: boolean;
  state: PullRequestState;
  author: TriggerActor;
};

/**
 * An issue or a pull request as the platform delivers it, for the ticket mirror (#923). The values are the platform's own: nothing is
 * mapped (`state`, `type` and the reason are shown as they come); the texts are those of whoever wrote the ticket, bounded, and data like
 * any other text.
 */
export type TrackerItemFields = {
  number: number;
  /** The platform's global id; how an item of a project board is matched with its ticket. */
  nodeId: string;
  kind: "issue" | "pull_request";
  state: "open" | "closed";
  /** The platform's reason (`completed`, `not_planned`, `reopened`); `merged` for a merged pull request; null for none. */
  stateReason: string | null;
  /** The issue type of the organization; null for none and for a pull request. */
  type: string | null;
  title: string;
  /** The start of the description, at most `TRACKER_EXCERPT_CHARS` characters. */
  bodyExcerpt: string;
  labels: { name: string; color: string }[];
  assignees: { login: string }[];
  /**
   * The issue this one is a sub-issue of, in the same repository; null for none; `undefined` when the delivery does not say (the cache
   * then keeps what it has).
   */
  parentNumber?: number | null;
  /** For a pull request: the issues of the same repository it closes (`Closes #12`). Empty for an issue. */
  closes: number[];
  /** ISO 8601 text in UTC: the platform's time of the last change. */
  updatedAt: string;
};

/** How much of a description the mirror keeps. */
export const TRACKER_EXCERPT_CHARS = 500;

/** What a verified delivery changed in the ticket mirror (#923), whatever the platform called the event. */
export type TrackerChange =
  /** An issue or pull request was created or changed. `resetChecks`: the commit of the pull request changed, its checks are not known. */
  | {
      kind: "item_changed";
      repo: RepoRef;
      item: TrackerItemFields;
      resetChecks: boolean;
    }
  /** An issue was deleted or moved to another repository. */
  | { kind: "item_removed"; repo: RepoRef; number: number }
  /** A sub-issue got a parent (`parent` is its number), or lost it (null). */
  | {
      kind: "parent_changed";
      repo: RepoRef;
      child: number;
      parent: number | null;
    }
  /** An item of a project board got another status (`null`: it has none now, or left the board). */
  | { kind: "board_status_changed"; nodeId: string; status: string | null }
  /** The checks of a commit changed: the cache asks the platform for the state of these pull requests. */
  | {
      kind: "checks_changed";
      repo: RepoRef;
      headSha: string;
      pullRequests: number[];
    };

/** What a delivery says about the ticket mirror: a change, or why it is none. */
export type TrackerChangeResult =
  | { kind: "change"; change: TrackerChange }
  | { kind: "ignored"; reason: string }
  | { kind: "invalid_payload"; reason: string };

/** Where a full sync of a repository's tickets stands, as far as the platform is asked: one page of one phase at a time. */
export type TrackerPageStep =
  /** Every issue and pull request, any state, oldest first. */
  | { phase: "issues"; page: number }
  /** The open pull requests, and the state of the checks of each. */
  | { phase: "checks"; page: number }
  /** The status of the items of the project boards of the repository. `after` is the opaque position the last page returned. */
  | { phase: "board"; after: string | null };

/** One page of a phase, and where the next one is. */
export type TrackerPage =
  | { phase: "issues"; items: TrackerItemFields[]; last: boolean }
  | {
      phase: "checks";
      pullRequests: { number: number; checksState: string | null }[];
      last: boolean;
    }
  | {
      phase: "board";
      /** False when the platform does not let the app read boards (a permission is missing): the phase has nothing to say. */
      available: boolean;
      items: { nodeId: string; status: string | null }[];
      /** The position to ask for next; null on the last page. */
      next: string | null;
    };

/** What a connection has accepted on the platform (#749): whether the app may write the contents of its repositories. */
export type ConnectionPermissions = { contentsWrite: boolean };

/**
 * A connection the platform itself can enumerate (GitHub App: an installation). Used to create and
 * update `integrations` rows without a user adding them by hand.
 */
export type DiscoveredConnection = {
  /** The platform's id for the connection (GitHub App: the installation id). */
  externalId: string;
  displayName: string;
  /** Non-secret settings, valid for the provider's `validateConfig`. */
  config: { [key: string]: JsonValue };
  /** The platform has paused the connection (GitHub: a suspended installation). */
  suspended: boolean;
};

export const INSTALLATION_ACTIONS = [
  "created",
  "deleted",
  "suspended",
  "unsuspended",
  "repositories_changed",
] as const;
export type InstallationAction = (typeof INSTALLATION_ACTIONS)[number];

/** What a verified delivery means for the app, whatever the platform called it. */
export type IntegrationEvent =
  | { kind: "review_trigger"; trigger: ReviewTrigger }
  /** The connection itself changed (installed, removed, repositories added or removed). */
  | {
      kind: "installation_changed";
      externalId: string;
      action: InstallationAction;
    }
  /**
   * A pull request was closed (merged or not). It starts nothing; the app uses it to drop the jobs
   * that are still waiting for that pull request.
   */
  | {
      kind: "pull_request_closed";
      repo: RepoRef;
      prNumber: number;
      merged: boolean;
    }
  /**
   * A pull request was turned into a draft. It starts nothing; the app drops the pull request's
   * waiting automatic jobs, because a draft is not reviewed automatically.
   */
  | { kind: "pull_request_drafted"; repo: RepoRef; prNumber: number }
  /**
   * A label was put on an issue (not on a pull request) by a person (#845). It starts no review: the workflows of the workspace
   * that are started by this label take it from here. Title, body and labels are the words of whoever opened the issue.
   */
  | { kind: "issue_labeled"; labeled: IssueLabeled }
  /**
   * A delivery of an event the app uses whose payload lacks fields the app reads (or has them with
   * the wrong type). Nothing can be done with it and a redelivery would not change that; `reason`
   * names the fields for the logs, never their values.
   */
  | { kind: "invalid_payload"; reason: string }
  /** Genuine but of no interest for reviews; `reason` is for logs, never for branching. */
  | { kind: "ignored"; reason: string };
