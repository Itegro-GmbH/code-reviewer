// SPDX-License-Identifier: LicenseRef-Proprietary

// What a delivery of a Jira Cloud dynamic webhook says (#1039). The events the factory registers for are `jira:issue_created`,
// `jira:issue_updated`, `jira:issue_deleted` and `comment_created`; the payload of all of them carries the issue as the REST API reads it
// (without `expand`), and an update carries a changelog whose `status` item says the move. Reads the payload and nothing else (no database,
// no network); everything in it is untrusted.
import { readJiraIssue, type JiraIssue } from "./issue.ts";

/** The events the factory registers a webhook for: the registration and the parser agree on this list. */
export const JIRA_WEBHOOK_EVENTS = [
  "jira:issue_created",
  "jira:issue_updated",
  "jira:issue_deleted",
  "comment_created",
] as const;

export type JiraChange =
  | {
      kind: "issue_changed";
      /** `commented`: a comment was added; the issue is read from the payload all the same. */
      event: "created" | "updated" | "commented";
      issue: JiraIssue;
      /** The move the changelog names; absent when the delivery moves no status (a creation moves none). */
      status?: { from: string | null; to: string };
      actor?: { accountId: string; name: string };
      matchedWebhookIds: number[];
    }
  | {
      kind: "issue_deleted";
      key: string;
      /** Time of the deletion, ISO UTC. */
      at: string;
      matchedWebhookIds: number[];
    }
  | { kind: "ignored"; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function matchedOf(body: Record<string, unknown>): number[] {
  return Array.isArray(body.matchedWebhookIds)
    ? body.matchedWebhookIds.filter(
        (id): id is number =>
          typeof id === "number" && Number.isSafeInteger(id),
      )
    : [];
}

function actorOf(
  body: Record<string, unknown>,
): { accountId: string; name: string } | undefined {
  const user = body.user;
  if (!isRecord(user) || typeof user.accountId !== "string") return undefined;
  return {
    accountId: user.accountId,
    name: typeof user.displayName === "string" ? user.displayName : "",
  };
}

/** An own property of the payload when it is a text. */
function ownString(
  record: Record<string, unknown>,
  name: string,
): string | undefined {
  const value: unknown = Object.hasOwn(record, name)
    ? Reflect.get(record, name)
    : undefined;
  return typeof value === "string" ? value : undefined;
}

type ChangelogItem = {
  field: string;
  fromString: string | null;
  toString: string;
};

function changelogOf(body: Record<string, unknown>): ChangelogItem[] {
  const log = body.changelog;
  if (!isRecord(log) || !Array.isArray(log.items)) return [];
  const items: ChangelogItem[] = [];
  for (const item of log.items) {
    if (!isRecord(item) || typeof item.field !== "string") continue;
    items.push({
      field: item.field,
      fromString: ownString(item, "fromString") ?? null,
      // `toString` is the name Jira gives the new value; read as data, so a payload without it does not find Object's method.
      toString: ownString(item, "toString") ?? "",
    });
  }
  return items;
}

/** The time of a delivery (`timestamp`, milliseconds since the epoch) as ISO UTC; the issue's own time when the payload has none. */
function timeOf(
  body: Record<string, unknown>,
  issue: JiraIssue | undefined,
): string {
  const stamp = body.timestamp;
  if (typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0)
    return new Date(stamp).toISOString();
  return issue?.updatedAt || new Date(0).toISOString();
}

export function parseJiraDelivery(
  body: unknown,
  siteUrl: string | undefined,
): JiraChange {
  if (!isRecord(body) || typeof body.webhookEvent !== "string")
    return { kind: "ignored", reason: "not_a_jira_event" };
  const event = body.webhookEvent;
  if (!(JIRA_WEBHOOK_EVENTS as readonly string[]).includes(event))
    return { kind: "ignored", reason: "event_not_followed" };

  const issue = readJiraIssue(body.issue, siteUrl);
  if (issue === undefined) return { kind: "ignored", reason: "no_issue" };
  const matchedWebhookIds = matchedOf(body);

  if (event === "jira:issue_deleted")
    return {
      kind: "issue_deleted",
      key: issue.key,
      at: timeOf(body, issue),
      matchedWebhookIds,
    };

  const items = event === "jira:issue_updated" ? changelogOf(body) : [];
  // The last status item is the state the issue ended in.
  const statusItem = items.filter((item) => item.field === "status").pop();
  const actor = actorOf(body);
  return {
    kind: "issue_changed",
    event:
      event === "jira:issue_created"
        ? "created"
        : event === "comment_created"
          ? "commented"
          : "updated",
    issue,
    ...(statusItem === undefined || statusItem.toString === ""
      ? {}
      : { status: { from: statusItem.fromString, to: statusItem.toString } }),
    ...(actor === undefined ? {} : { actor }),
    matchedWebhookIds,
  };
}
