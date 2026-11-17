// SPDX-License-Identifier: LicenseRef-Proprietary

// What a delivery of a Jira Cloud dynamic webhook says (#1039). The events the factory registers for are `jira:issue_created`,
// `jira:issue_updated`, `jira:issue_deleted` and `comment_created`; the payload of all of them carries the issue as the REST API reads it
// (without `expand`), and an update carries a changelog whose `status` item says the move. Reads the payload and nothing else (no database,
// no network); everything in it is untrusted.
import { adfToText } from "./adf.ts";
import { jiraTime, readJiraIssue, type JiraIssue } from "./issue.ts";

/** The events the factory registers a webhook for: the registration and the parser agree on this list. */
export const JIRA_WEBHOOK_EVENTS = [
  "jira:issue_created",
  "jira:issue_updated",
  "jira:issue_deleted",
  "comment_created",
] as const;

/** The comment a `comment_created` delivery carries (#1040): who wrote it and what it says, as text. Untrusted. */
export type JiraComment = {
  id: string;
  /** The comment as plain text (Jira sends ADF or, for some webhooks, wiki text; both are read as text). */
  text: string;
  /** The account that wrote it; `accountType` is `atlassian` for a person, `app` for an app, `customer` for a portal customer. */
  author: { accountId: string; name: string; accountType: string };
  /** When it was written, ISO UTC; empty when the payload has none. */
  createdAt: string;
};

/** A comment is read up to this long: an answer is bounded far below it, and a payload is untrusted. */
const COMMENT_TEXT_MAX_CHARS = 20_000;

export type JiraChange =
  | {
      kind: "issue_changed";
      /** `commented`: a comment was added; the issue is read from the payload all the same. */
      event: "created" | "updated" | "commented";
      issue: JiraIssue;
      /**
       * The move the changelog names; absent when the delivery moves no status (a creation moves none). `from` and `to` are the names the
       * delivery carries (Jira keeps one name for every language here, the REST API says the localized one), `fromId` and `toId` the ids of
       * the statuses, which are the same in every language (#1058); an id is absent when the payload has none.
       */
      status?: {
        from: string | null;
        to: string;
        fromId?: string;
        toId?: string;
      };
      actor?: { accountId: string; name: string };
      /** Only for `commented`. */
      comment?: JiraComment;
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
  /** The ids of the values (`from`, `to` of Jira's changelog item); for a status they are the status ids. */
  from: string | null;
  to: string | null;
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
      from: ownString(item, "from") ?? null,
      to: ownString(item, "to") ?? null,
    });
  }
  return items;
}

function commentOf(body: Record<string, unknown>): JiraComment | undefined {
  const comment = body.comment;
  if (!isRecord(comment) || typeof comment.id !== "string" || comment.id === "")
    return undefined;
  const author = isRecord(comment.author) ? comment.author : {};
  const raw = comment.body;
  const text =
    typeof raw === "string" ? raw : isRecord(raw) ? adfToText(raw) : "";
  return {
    id: comment.id,
    text: Array.from(text).slice(0, COMMENT_TEXT_MAX_CHARS).join(""),
    author: {
      accountId: typeof author.accountId === "string" ? author.accountId : "",
      name: typeof author.displayName === "string" ? author.displayName : "",
      accountType:
        typeof author.accountType === "string" ? author.accountType : "",
    },
    createdAt: jiraTime(comment.created),
  };
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

/**
 * The move a `status` item says. The ids are the item's `from` and `to` (Jira always sends them for a status). The payload issue's own
 * status is not used as a fallback for the new one: it shows the issue as it is when the delivery is made, which may be later than this change.
 */
function statusMoveOf(item: ChangelogItem) {
  return {
    from: item.fromString,
    to: item.toString,
    ...(item.from === null || item.from === "" ? {} : { fromId: item.from }),
    ...(item.to === null || item.to === "" ? {} : { toId: item.to }),
  };
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
  const comment = event === "comment_created" ? commentOf(body) : undefined;
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
      : { status: statusMoveOf(statusItem) }),
    ...(actor === undefined ? {} : { actor }),
    ...(comment === undefined ? {} : { comment }),
    matchedWebhookIds,
  };
}
