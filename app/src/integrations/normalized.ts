// SPDX-License-Identifier: LicenseRef-Proprietary

// Runtime guards for the normalized types. The key sets are exact on purpose: a provider that
// copies a raw platform object into a RepoRef, ReviewTrigger or GitAccess is caught here instead of
// leaking the platform's format into jobs, the runner API or the UI. Also home of the helpers that
// keep a GitAccess token out of logs and accidental serialization.
import { IntegrationError } from "./errors.ts";
import {
  GIT_AUTH_TYPES,
  GIT_PLATFORMS,
  INSTALLATION_ACTIONS,
  PULL_REQUEST_STATES,
  REVIEW_COMMANDS,
  REVIEW_TRIGGER_KINDS,
  TRIGGER_PULL_REQUEST_STATES,
  type GitAccess,
  type IntegrationEvent,
  type PullRequestRef,
  type RepoRef,
  type ReviewTrigger,
} from "./types.ts";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own property names, enumerable or not, so a hidden field cannot slip past the key check. */
function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.getOwnPropertyNames(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

/** Own property names: all of `required` and no name beyond `required` and `optional`. */
function hasKeysWithin(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const actual = Object.getOwnPropertyNames(value);
  return (
    required.every((key) => actual.includes(key)) &&
    actual.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return values.some((candidate) => candidate === value);
}

export function isRepoRef(value: unknown): value is RepoRef {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ["integrationId", "externalId", "fullName", "url"]))
    return false;
  return (
    isNonEmptyString(value.integrationId) &&
    isNonEmptyString(value.externalId) &&
    isNonEmptyString(value.fullName) &&
    isNonEmptyString(value.url)
  );
}

function isActor(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["login", "externalId"]))
    return false;
  return (
    isNonEmptyString(value.login) &&
    (value.externalId === null || isNonEmptyString(value.externalId))
  );
}

export function isReviewTrigger(value: unknown): value is ReviewTrigger {
  if (!isRecord(value)) return false;
  const keys = [
    "kind",
    "repo",
    "prNumber",
    "prUrl",
    "headSha",
    "command",
    "args",
    "actor",
  ];
  // Only a pull request trigger knows whether the pull request is a draft and whether it is open;
  // only a command trigger knows the comment it came from.
  if (
    !hasExactKeys(
      value,
      value.kind === "command"
        ? [...keys, "commentId"]
        : [...keys, "draft", "state"],
    )
  )
    return false;
  if (!isOneOf(REVIEW_TRIGGER_KINDS, value.kind)) return false;
  if (!isRepoRef(value.repo) || !isActor(value.actor)) return false;
  if (!Number.isInteger(value.prNumber) || (value.prNumber as number) < 1)
    return false;
  if (!isNonEmptyString(value.prUrl) || !isNonEmptyString(value.headSha))
    return false;

  if (value.kind === "command") {
    return (
      isOneOf(REVIEW_COMMANDS, value.command) &&
      typeof value.args === "string" &&
      isNonEmptyString(value.commentId)
    );
  }
  return (
    value.command === null &&
    value.args === null &&
    typeof value.draft === "boolean" &&
    isOneOf(TRIGGER_PULL_REQUEST_STATES, value.state)
  );
}

export function isPullRequestRef(value: unknown): value is PullRequestRef {
  if (!isRecord(value)) return false;
  const keys = [
    "number",
    "title",
    "url",
    "headSha",
    "baseRef",
    "headRef",
    "draft",
    "state",
    "author",
  ];
  if (!hasExactKeys(value, keys)) return false;
  return (
    Number.isInteger(value.number) &&
    (value.number as number) >= 1 &&
    typeof value.title === "string" &&
    isNonEmptyString(value.url) &&
    isNonEmptyString(value.headSha) &&
    isNonEmptyString(value.baseRef) &&
    isNonEmptyString(value.headRef) &&
    typeof value.draft === "boolean" &&
    isOneOf(PULL_REQUEST_STATES, value.state) &&
    isActor(value.author)
  );
}

function isIssueLabeled(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, ["repo", "defaultBranch", "issue", "label", "actor"])
  )
    return false;
  const { issue } = value;
  return (
    isRepoRef(value.repo) &&
    isNonEmptyString(value.defaultBranch) &&
    isNonEmptyString(value.label) &&
    isActor(value.actor) &&
    isRecord(issue) &&
    hasKeysWithin(
      issue,
      ["number", "title", "body", "url", "labels"],
      ["assignees", "type"],
    ) &&
    Number.isInteger(issue.number) &&
    (issue.number as number) >= 1 &&
    typeof issue.title === "string" &&
    typeof issue.body === "string" &&
    isNonEmptyString(issue.url) &&
    Array.isArray(issue.labels) &&
    issue.labels.every((name: unknown) => typeof name === "string") &&
    (issue.assignees === undefined ||
      (Array.isArray(issue.assignees) &&
        issue.assignees.every((name: unknown) => typeof name === "string"))) &&
    (issue.type === undefined || typeof issue.type === "string")
  );
}

function isTicketAnswer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !hasKeysWithin(
      value,
      ["repo", "number", "commentId", "actor", "raw"],
      ["choice", "text"],
    )
  )
    return false;
  return (
    isRepoRef(value.repo) &&
    Number.isInteger(value.number) &&
    (value.number as number) >= 1 &&
    isNonEmptyString(value.commentId) &&
    isActor(value.actor) &&
    isNonEmptyString(value.raw) &&
    (value.choice === undefined ||
      (Number.isInteger(value.choice) && (value.choice as number) >= 1)) &&
    (value.text === undefined || isNonEmptyString(value.text))
  );
}

export function isIntegrationEvent(value: unknown): value is IntegrationEvent {
  if (!isRecord(value)) return false;
  if (value.kind === "review_trigger")
    return (
      hasExactKeys(value, ["kind", "trigger"]) && isReviewTrigger(value.trigger)
    );
  if (value.kind === "installation_changed")
    return (
      hasExactKeys(value, ["kind", "externalId", "action"]) &&
      isNonEmptyString(value.externalId) &&
      isOneOf(INSTALLATION_ACTIONS, value.action)
    );
  if (value.kind === "pull_request_closed")
    return (
      hasExactKeys(value, ["kind", "repo", "prNumber", "merged"]) &&
      isRepoRef(value.repo) &&
      Number.isInteger(value.prNumber) &&
      (value.prNumber as number) >= 1 &&
      typeof value.merged === "boolean"
    );
  if (value.kind === "pull_request_drafted")
    return (
      hasExactKeys(value, ["kind", "repo", "prNumber"]) &&
      isRepoRef(value.repo) &&
      Number.isInteger(value.prNumber) &&
      (value.prNumber as number) >= 1
    );
  if (value.kind === "issue_labeled")
    return (
      hasExactKeys(value, ["kind", "labeled"]) && isIssueLabeled(value.labeled)
    );
  if (value.kind === "ticket_answer")
    return (
      hasExactKeys(value, ["kind", "answer"]) && isTicketAnswer(value.answer)
    );
  if (value.kind === "ignored" || value.kind === "invalid_payload")
    return (
      hasExactKeys(value, ["kind", "reason"]) && isNonEmptyString(value.reason)
    );
  return false;
}

const GIT_ACCESS_KEYS = [
  "provider",
  "baseUrl",
  "token",
  "authType",
  "botLogin",
  "expiresAt",
];

/** A GitAccess is only valid when its token is hidden (see `createGitAccess`). */
export function isGitAccess(value: unknown): value is GitAccess {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, GIT_ACCESS_KEYS)) return false;
  if (Object.getOwnPropertyDescriptor(value, "token")?.enumerable !== false)
    return false;
  return (
    isOneOf(GIT_PLATFORMS, value.provider) &&
    isOneOf(GIT_AUTH_TYPES, value.authType) &&
    isNonEmptyString(value.baseUrl) &&
    isNonEmptyString(value.token) &&
    (value.botLogin === null || isNonEmptyString(value.botLogin)) &&
    (value.expiresAt === null || isNonEmptyString(value.expiresAt))
  );
}

/**
 * Builds a GitAccess whose `token` is readable (`access.token`) but not enumerable: JSON.stringify,
 * spread, Object.entries and console output leave it out, so passing the object to a logger or an
 * error cannot leak it. Every provider returns its access through this function.
 */
export function createGitAccess(fields: GitAccess): GitAccess {
  const { token, ...visible } = fields;
  const access = { ...visible };
  Object.defineProperty(access, "token", {
    value: token,
    enumerable: false,
    writable: false,
  });
  return access as GitAccess;
}

/**
 * A plain copy with the token included, for the one place that must send it on (the runner API's
 * claim response). Calling it is a deliberate act; do not log its result. Throws
 * INTEGRATION_ACCESS_TOKEN_MISSING when the token is missing or empty, so a broken access is never
 * sent to a runner as if it were usable.
 */
export function revealGitAccess(access: GitAccess): GitAccess {
  if (typeof access.token !== "string" || access.token === "")
    throw new IntegrationError(
      "INTEGRATION_ACCESS_TOKEN_MISSING",
      "The git access has no token to hand out.",
    );
  return {
    provider: access.provider,
    baseUrl: access.baseUrl,
    token: access.token,
    authType: access.authType,
    botLogin: access.botLogin,
    expiresAt: access.expiresAt,
  };
}
