// SPDX-License-Identifier: LicenseRef-Proprietary

// A Jira issue as the factory's neutral ticket (#1039): what the webhook payload and `GET /rest/api/3/issue/{key}` carry, mapped to the
// fields every ticket source fills (key, title = summary, body = description as plain text, status name, type, assignees, labels, parent,
// address). The texts are those of whoever wrote the issue: untrusted. Jira's own status names are kept, never mapped (epic #1034).
import { JIRA_ISSUE_KEY } from "../workflows/ticket-ref.ts";
import { adfToText } from "./adf.ts";

const ISSUE_KEY = JIRA_ISSUE_KEY;

export const isJiraIssueKey = (key: string): boolean => ISSUE_KEY.test(key);

/** The number at the end of a key (`PROJ-123` is 123), or undefined for a text that is no key. */
export function issueNumberOfKey(key: string): number | undefined {
  const match = ISSUE_KEY.exec(key);
  return match === null ? undefined : Number(match[2]);
}

/** The project part of a key (`PROJ-123` is `PROJ`). */
export function projectKeyOfIssueKey(key: string): string | undefined {
  return ISSUE_KEY.exec(key)?.[1];
}

export type JiraStatusCategoryKey = "new" | "indeterminate" | "done";

export type JiraIssue = {
  /** Jira's numeric id of the issue as text; it stays when the key changes (a move to another project). */
  id: string;
  key: string;
  projectKey: string;
  /** The number at the end of the key: what the mirror's row is keyed by next to the key. */
  number: number;
  title: string;
  /** The description as plain text. */
  body: string;
  /** The name of the status, as Jira spells it. */
  status: string;
  statusCategory: JiraStatusCategoryKey;
  /** The issue type (`Bug`, `Task`, ...); empty when the payload has none. */
  type: string;
  /** The display names of the assignee (Jira has one). */
  assignees: string[];
  labels: string[];
  /** The key of the parent (an epic, or the parent of a sub-task); undefined for none. */
  parentKey?: string;
  /** `<site>/browse/<key>`; empty when the site address is not known. */
  url: string;
  /** Jira's time of the last change, normalised to UTC (`2026-11-14T09:30:00.123Z`); empty when absent. */
  updatedAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** Jira's `2026-11-14T10:30:00.123+0100` as ISO UTC; an unreadable time is empty. */
export function jiraTime(value: unknown): string {
  if (typeof value !== "string") return "";
  // `+0100` has no colon, which `Date` does not take everywhere.
  const fixed = value.replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  const parsed = Date.parse(fixed);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

/**
 * The issue a payload or a read of the REST API holds, or undefined when it has no usable id, key or fields. `siteUrl` (the address of the
 * Jira site, `https://acme.atlassian.net`) builds the link; without it the url is empty.
 */
export function readJiraIssue(
  value: unknown,
  siteUrl: string | undefined,
): JiraIssue | undefined {
  if (!isRecord(value) || !isRecord(value.fields)) return undefined;
  const { id, key, fields } = value;
  if (typeof id !== "string" || id === "" || typeof key !== "string")
    return undefined;
  const match = ISSUE_KEY.exec(key);
  if (match === null) return undefined;
  if (typeof fields.summary !== "string") return undefined;

  const status = isRecord(fields.status) ? fields.status : {};
  const category = isRecord(status.statusCategory)
    ? status.statusCategory.key
    : undefined;
  const assignee = isRecord(fields.assignee) ? fields.assignee : undefined;
  const assigneeName =
    assignee === undefined
      ? ""
      : text(assignee.displayName) || text(assignee.accountId);
  const parentKey = isRecord(fields.parent) ? fields.parent.key : undefined;

  return {
    id,
    key,
    projectKey: match[1] ?? "",
    number: Number(match[2]),
    title: fields.summary,
    body: adfToText(fields.description),
    status: text(status.name),
    statusCategory:
      category === "new" || category === "done" ? category : "indeterminate",
    type: isRecord(fields.issuetype) ? text(fields.issuetype.name) : "",
    assignees: assigneeName === "" ? [] : [assigneeName],
    labels: Array.isArray(fields.labels)
      ? fields.labels.filter(
          (label): label is string => typeof label === "string" && label !== "",
        )
      : [],
    ...(typeof parentKey === "string" && ISSUE_KEY.test(parentKey)
      ? { parentKey }
      : {}),
    url:
      siteUrl === undefined || siteUrl === ""
        ? ""
        : `${siteUrl.replace(/\/+$/, "")}/browse/${key}`,
    updatedAt: jiraTime(fields.updated),
  };
}
