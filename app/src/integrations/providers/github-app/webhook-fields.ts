// SPDX-License-Identifier: LicenseRef-Proprietary

// The part of each GitHub webhook payload that Code Reviewer reads, as data. `events.ts` checks a
// payload against it before it reads anything, and the contract test checks the recorded payloads in
// `fakes/fixtures/github-webhooks/` against the same list, so the two cannot drift apart: a field
// that is read but not listed here cannot be read at all.

export type PayloadFieldType =
  "string" | "number" | "boolean" | "object" | "array";

export type PayloadFieldSpec = {
  /** Dotted path from the root of the payload, for example "pull_request.head.sha". */
  path: string;
  type: PayloadFieldType;
  /** Absent is fine; if present, the type must match. */
  optional?: boolean;
  /** `null` is fine too (GitHub sends the body of an issue without a description as `null`). */
  nullable?: boolean;
};

const INSTALLATION: PayloadFieldSpec[] = [
  { path: "action", type: "string" },
  { path: "installation.id", type: "number" },
];

const REPOSITORY: PayloadFieldSpec[] = [
  { path: "repository.id", type: "number" },
  { path: "repository.full_name", type: "string" },
  { path: "repository.html_url", type: "string" },
];

const SENDER: PayloadFieldSpec[] = [
  { path: "sender.login", type: "string" },
  { path: "sender.id", type: "number" },
  { path: "sender.type", type: "string" },
];

export const WEBHOOK_READ_FIELDS = {
  installation: INSTALLATION,
  installation_repositories: INSTALLATION,
  pull_request: [
    { path: "action", type: "string" },
    { path: "number", type: "number" },
    { path: "pull_request.html_url", type: "string" },
    { path: "pull_request.head.sha", type: "string" },
    // Whether the pull request is still work in progress, still open, and (for a closed one) merged.
    { path: "pull_request.draft", type: "boolean" },
    { path: "pull_request.state", type: "string" },
    { path: "pull_request.merged", type: "boolean" },
    { path: "installation.id", type: "number" },
    ...REPOSITORY,
    ...SENDER,
  ],
  issue_comment: [
    { path: "action", type: "string" },
    { path: "issue.number", type: "number" },
    { path: "issue.state", type: "string" },
    // Present only when the comment is on a pull request, not on a plain issue.
    { path: "issue.pull_request", type: "object", optional: true },
    // The id of the comment: a replayed delivery of the same comment must not start a second job.
    { path: "comment.id", type: "number" },
    { path: "comment.body", type: "string" },
    // Who can write at all: only OWNER, MEMBER and COLLABORATOR can, so others cost no API call.
    { path: "comment.author_association", type: "string" },
    { path: "installation.id", type: "number" },
    ...REPOSITORY,
    ...SENDER,
  ],
  // #845: an issue got a label. The label is read only for `labeled`, so it is optional here; the parser asks for it.
  issues: [
    { path: "action", type: "string" },
    { path: "issue.number", type: "number" },
    { path: "issue.title", type: "string" },
    { path: "issue.body", type: "string", optional: true, nullable: true },
    { path: "issue.html_url", type: "string" },
    { path: "issue.state", type: "string" },
    { path: "issue.labels", type: "array" },
    // Present only when the "issue" is a pull request.
    { path: "issue.pull_request", type: "object", optional: true },
    { path: "label.name", type: "string", optional: true },
    { path: "repository.default_branch", type: "string" },
    { path: "installation.id", type: "number" },
    ...REPOSITORY,
    ...SENDER,
  ],
} as const satisfies Record<string, PayloadFieldSpec[]>;

export type WebhookEventName = keyof typeof WEBHOOK_READ_FIELDS;

export function isReadWebhookEvent(name: string): name is WebhookEventName {
  return Object.hasOwn(WEBHOOK_READ_FIELDS, name);
}

function valueAt(payload: unknown, path: string): unknown {
  let current: unknown = payload;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function matches(value: unknown, type: PayloadFieldType): boolean {
  if (type === "object")
    return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  return typeof value === type;
}

/** The listed paths that are missing or have the wrong type in `payload` (empty when it fits). */
export function payloadProblems(
  event: WebhookEventName,
  payload: unknown,
): string[] {
  return specProblems(WEBHOOK_READ_FIELDS[event], payload);
}

/** The paths of `specs` that are missing or have the wrong type in `payload` (empty when it fits). */
export function specProblems(
  specs: readonly PayloadFieldSpec[],
  payload: unknown,
): string[] {
  return specs
    .filter((spec: PayloadFieldSpec) => {
      const value = valueAt(payload, spec.path);
      if (value === undefined && spec.optional === true) return false;
      if (value === null && spec.nullable === true) return false;
      return !matches(value, spec.type);
    })
    .map((spec: PayloadFieldSpec) => spec.path);
}

// #923: what the ticket mirror reads on top of `WEBHOOK_READ_FIELDS`, per event. The mirror is a cache: a delivery that lacks one of these
// is not an error for the review or the workflows (it is not refused), the mirror just does not learn from it. The contract test checks the
// recorded payloads of these events against this list. The ticket objects (`issue`, `pull_request`) are read by `toTrackerItem`, which
// tells a missing or wrongly typed field itself.
const TRACKER_REPOSITORY: PayloadFieldSpec[] = [
  { path: "action", type: "string" },
  { path: "installation.id", type: "number" },
  { path: "repository.id", type: "number" },
  { path: "repository.full_name", type: "string" },
  { path: "repository.html_url", type: "string" },
];

export const TRACKER_WEBHOOK_FIELDS = {
  issues: [
    ...TRACKER_REPOSITORY,
    { path: "issue", type: "object" },
    { path: "issue.number", type: "number" },
    { path: "issue.node_id", type: "string" },
    { path: "issue.updated_at", type: "string" },
  ],
  issue_comment: [
    ...TRACKER_REPOSITORY,
    { path: "issue", type: "object" },
    { path: "issue.node_id", type: "string" },
    { path: "issue.updated_at", type: "string" },
  ],
  pull_request: [
    ...TRACKER_REPOSITORY,
    { path: "pull_request", type: "object" },
    { path: "pull_request.node_id", type: "string" },
    { path: "pull_request.updated_at", type: "string" },
  ],
  sub_issues: [
    ...TRACKER_REPOSITORY,
    { path: "parent_issue.number", type: "number" },
    { path: "sub_issue.number", type: "number" },
    // Present when the two issues are in different repositories; equal otherwise.
    { path: "parent_issue_repo.full_name", type: "string", optional: true },
    { path: "sub_issue_repo.full_name", type: "string", optional: true },
  ],
  // A board belongs to the organization, so the delivery has no `repository`: the item is found by the node id of its content.
  projects_v2_item: [
    { path: "action", type: "string" },
    { path: "installation.id", type: "number" },
    { path: "projects_v2_item.content_node_id", type: "string" },
    { path: "projects_v2_item.content_type", type: "string" },
    { path: "changes", type: "object", optional: true },
  ],
  check_suite: [
    ...TRACKER_REPOSITORY,
    { path: "check_suite.head_sha", type: "string" },
    { path: "check_suite.pull_requests", type: "array" },
  ],
} as const satisfies Record<string, PayloadFieldSpec[]>;

export type TrackerWebhookEventName = keyof typeof TRACKER_WEBHOOK_FIELDS;

export function isTrackerWebhookEvent(
  name: string,
): name is TrackerWebhookEventName {
  return Object.hasOwn(TRACKER_WEBHOOK_FIELDS, name);
}

/** Reads a path that `payloadProblems` has already accepted. */
export function field<T extends string | number | boolean>(
  payload: unknown,
  path: string,
): T {
  return valueAt(payload, path) as T;
}

export function hasField(payload: unknown, path: string): boolean {
  return valueAt(payload, path) !== undefined;
}

/** The value at a path of a payload that `payloadProblems` accepted, when its type is not one of the scalars `field` takes. */
export function rawField(payload: unknown, path: string): unknown {
  return valueAt(payload, path);
}
