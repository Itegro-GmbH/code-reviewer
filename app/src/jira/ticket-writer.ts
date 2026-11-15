// SPDX-License-Identifier: LicenseRef-Proprietary

// What a lane writes to a Jira issue (#1040, epic #1034): a comment (Markdown as ADF), an edit of the factory's own comment, labels and the
// transition to a status. All of it goes through `JiraTokens.request`, so the token is refreshed, renewed on a 401 and never seen here. A
// failure is a `TicketProviderError` with a stable code and a text that holds nothing of what Jira said (its messages name people and tickets).
//
// - The factory's comments carry a hidden marker (`<!-- factory ask run=… -->`, a run-and-step key). ADF cannot hide text, so the marker is
//   kept as a comment PROPERTY (`factory.markers`) and looked for there: a comment the factory finds again by its marker is its own (the
//   author is the account the connection was made with: OAuth 3LO writes as that person) and holds the marker, so a step that is made
//   again does not comment twice, and the question of an agent is edited in place when it is answered.
// - Jira's labels cannot contain spaces: a label the factory names ("agent waiting") is written with a hyphen ("agent-waiting").
// - A status is reached by a transition that Jira offers from the issue's current status: it is looked up by the name of the status it ends
//   in. A status the workflow has but no transition leads to is `status_unreachable` (with the ones that are reachable); a name the workflow
//   does not have at all is `status_unknown`. A transition that needs a field the factory cannot fill is refused with `ticket_rejected`.
import {
  TicketProviderError,
  type TicketProvider,
  type TicketProviderErrorCode,
} from "../integrations/ticket-provider.ts";
import { isJiraIssueKey } from "./issue.ts";
import { extractMarkers, markdownToAdf } from "./markdown-adf.ts";
import type { JiraProjectReader } from "./projects.ts";
import type { JiraTokens } from "./tokens.ts";

/** The comment property the markers of a comment are kept under. */
export const MARKER_PROPERTY = "factory.markers";

/** How many pages of comments (newest first) the search for an earlier comment of the step reads at most. */
const COMMENT_PAGES_MAX = 5;
const COMMENT_PAGE_SIZE = 100;

type Writes = Pick<
  TicketProvider,
  | "commentOnTicket"
  | "updateTicketComment"
  | "changeTicketLabels"
  | "setTicketStatus"
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** A label Jira takes: no whitespace (a run of it becomes one hyphen), at most 255 characters. */
export function jiraLabel(label: string): string {
  return label.trim().replace(/\s+/g, "-").slice(0, 255);
}

const fail = (code: TicketProviderErrorCode): TicketProviderError =>
  new TicketProviderError(code, MESSAGES[code]);

const MESSAGES: Record<TicketProviderErrorCode, string> = {
  ticket_not_found: "Jira has no such issue or comment for this connection.",
  ticket_forbidden:
    "Jira refuses the account of the connection: it may not see the issue or write to it.",
  ticket_connection_broken:
    "The Jira connection of this workspace is broken: connect it again in the workspace settings.",
  ticket_unavailable: "Jira could not be reached or did not answer in time.",
  ticket_rejected: "Jira refused the request.",
};

/** The failure a status of a Jira answer stands for. */
function failureOf(status: number): TicketProviderError {
  if (status === 401 || status === 403) return fail("ticket_forbidden");
  if (status === 404) return fail("ticket_not_found");
  if (status === 400 || status === 409 || status === 422)
    return fail("ticket_rejected");
  return fail("ticket_unavailable");
}

export type JiraTicketWriterDependencies = {
  tokens: Pick<JiraTokens, "request">;
  /** The address of the connection's site, for the link of a comment; undefined for no such connection. */
  siteUrlOf(connectionId: string): Promise<string | undefined>;
  /** The Atlassian account the connection was made with: the author of the factory's comments. */
  accountIdOf(connectionId: string): Promise<string | undefined>;
  statuses: Pick<JiraProjectReader, "listStatuses">;
};

export type JiraTicketWriter = {
  comment(
    connectionId: string,
    key: string,
    body: string,
    options?: {
      signal?: AbortSignal;
      marker?: string;
      since?: string;
    },
  ): Promise<{ url: string; existing: boolean; id: string }>;
  updateComment(
    connectionId: string,
    key: string,
    commentId: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<void>;
  changeLabels(
    connectionId: string,
    key: string,
    change: { add: readonly string[]; remove: readonly string[] },
    signal?: AbortSignal,
  ): Promise<{ labels: string[] }>;
  setStatus(
    connectionId: string,
    projectKey: string,
    key: string,
    status: string,
    signal?: AbortSignal,
  ): ReturnType<NonNullable<Writes["setTicketStatus"]>>;
};

export function createJiraTicketWriter(
  deps: JiraTicketWriterDependencies,
): JiraTicketWriter {
  /** One call through the token handling; a failure of the call itself is a `TicketProviderError`. */
  async function call(
    connectionId: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    let result;
    try {
      result = await deps.tokens.request(connectionId, path, init);
    } catch {
      throw fail("ticket_unavailable");
    }
    if (result.ok) return result.response;
    if (result.error === "jira_connection_broken")
      throw fail("ticket_connection_broken");
    if (result.error === "jira_connection_not_found")
      throw fail("ticket_not_found");
    throw fail("ticket_unavailable");
  }

  const jsonInit = (
    method: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): RequestInit => ({
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });

  const commentPath = (key: string) =>
    `/rest/api/3/issue/${encodeURIComponent(key)}/comment`;

  /** The ADF and the properties of a Markdown comment: the markers are kept as a property, not written into the document. */
  function commentPayload(body: string, extra: readonly string[] = []) {
    const { markers, text } = extractMarkers(body);
    const all = [...new Set([...markers, ...extra])];
    return {
      body: markdownToAdf(text),
      properties:
        all.length === 0
          ? []
          : [{ key: MARKER_PROPERTY, value: { markers: all } }],
    };
  }

  const linkOf = async (connectionId: string, key: string, id: string) => {
    const site = (await deps.siteUrlOf(connectionId))?.replace(/\/+$/, "");
    return site === undefined
      ? ""
      : `${site}/browse/${encodeURIComponent(key)}?focusedCommentId=${encodeURIComponent(id)}`;
  };

  /** The factory's own comment that holds `marker`, looked for newest first, no further back than `since`. */
  async function findOwn(
    connectionId: string,
    key: string,
    marker: string,
    since: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const account = await deps.accountIdOf(connectionId);
    if (account === undefined) return undefined;
    const bound = since === undefined ? Number.NaN : Date.parse(since);
    for (let page = 0; page < COMMENT_PAGES_MAX; page += 1) {
      const response = await call(
        connectionId,
        `${commentPath(key)}?orderBy=-created&expand=properties&startAt=${String(page * COMMENT_PAGE_SIZE)}&maxResults=${String(COMMENT_PAGE_SIZE)}`,
        {
          headers: { accept: "application/json" },
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw failureOf(response.status);
      }
      const body = await jsonOf(response);
      if (!isRecord(body) || !Array.isArray(body.comments))
        throw fail("ticket_unavailable");
      const comments: unknown[] = body.comments;
      for (const comment of comments) {
        if (!isRecord(comment) || typeof comment.id !== "string") continue;
        const created = Date.parse(
          String(comment.created ?? "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"),
        );
        // Newest first: nothing older than the step can hold its marker.
        if (!Number.isNaN(bound) && !Number.isNaN(created) && created < bound)
          return undefined;
        const author = isRecord(comment.author)
          ? comment.author.accountId
          : undefined;
        if (author !== account) continue;
        const properties: unknown[] = Array.isArray(comment.properties)
          ? comment.properties
          : [];
        for (const property of properties)
          if (
            isRecord(property) &&
            property.key === MARKER_PROPERTY &&
            isRecord(property.value) &&
            Array.isArray(property.value.markers) &&
            property.value.markers.includes(marker)
          )
            return comment.id;
      }
      if (comments.length < COMMENT_PAGE_SIZE) return undefined;
    }
    return undefined;
  }

  return {
    async comment(connectionId, key, body, options = {}) {
      if (!isJiraIssueKey(key)) throw fail("ticket_not_found");
      const { marker, since, signal } = options;
      if (marker !== undefined) {
        const existing = await findOwn(
          connectionId,
          key,
          marker,
          since,
          signal,
        );
        if (existing !== undefined)
          return {
            url: await linkOf(connectionId, key, existing),
            existing: true,
            id: existing,
          };
      }
      const response = await call(
        connectionId,
        commentPath(key),
        jsonInit(
          "POST",
          commentPayload(body, marker === undefined ? [] : [marker]),
          signal,
        ),
      );
      if (response.status !== 201 && response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw failureOf(response.status);
      }
      const created = await jsonOf(response);
      if (!isRecord(created) || typeof created.id !== "string")
        throw fail("ticket_unavailable");
      return {
        url: await linkOf(connectionId, key, created.id),
        existing: false,
        id: created.id,
      };
    },

    async updateComment(connectionId, key, commentId, body, signal) {
      if (!isJiraIssueKey(key) || !/^\d{1,19}$/.test(commentId))
        throw fail("ticket_not_found");
      // The properties are replaced with the markers of the new body: `answered` takes the place of `ask`.
      const response = await call(
        connectionId,
        `${commentPath(key)}/${commentId}?notifyUsers=false`,
        jsonInit("PUT", commentPayload(body), signal),
      );
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw failureOf(response.status);
    },

    async changeLabels(connectionId, key, change, signal) {
      if (!isJiraIssueKey(key)) throw fail("ticket_not_found");
      const add = [...new Set(change.add.map(jiraLabel))].filter(
        (label) => label !== "",
      );
      const remove = [...new Set(change.remove.map(jiraLabel))].filter(
        (label) => label !== "" && !add.includes(label),
      );
      const path = `/rest/api/3/issue/${encodeURIComponent(key)}`;
      const edit = await call(
        connectionId,
        `${path}?notifyUsers=false`,
        jsonInit(
          "PUT",
          {
            update: {
              labels: [
                ...add.map((label) => ({ add: label })),
                ...remove.map((label) => ({ remove: label })),
              ],
            },
          },
          signal,
        ),
      );
      await edit.body?.cancel().catch(() => undefined);
      if (!edit.ok) throw failureOf(edit.status);
      const read = await call(connectionId, `${path}?fields=labels`, {
        headers: { accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!read.ok) {
        await read.body?.cancel().catch(() => undefined);
        throw failureOf(read.status);
      }
      const issue = await jsonOf(read);
      const labels =
        isRecord(issue) &&
        isRecord(issue.fields) &&
        Array.isArray(issue.fields.labels)
          ? (issue.fields.labels as unknown[]).filter(
              (label): label is string => typeof label === "string",
            )
          : [];
      return { labels };
    },

    async setStatus(connectionId, projectKey, key, status, signal) {
      if (!isJiraIssueKey(key)) return { kind: "issue_not_found" };
      const path = `/rest/api/3/issue/${encodeURIComponent(key)}`;
      const wanted = status.trim().toLowerCase();
      const read = await call(connectionId, `${path}?fields=status`, {
        headers: { accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
      if (read.status === 404) {
        await read.body?.cancel().catch(() => undefined);
        return { kind: "issue_not_found" };
      }
      if (!read.ok) {
        await read.body?.cancel().catch(() => undefined);
        throw failureOf(read.status);
      }
      const issue = await jsonOf(read);
      const current =
        isRecord(issue) &&
        isRecord(issue.fields) &&
        isRecord(issue.fields.status) &&
        typeof issue.fields.status.name === "string"
          ? issue.fields.status.name
          : undefined;
      if (current === undefined) throw fail("ticket_unavailable");
      // Already there: nothing to do (the step may be made again).
      if (current.trim().toLowerCase() === wanted)
        return { kind: "moved", status: current };

      const offered = await call(connectionId, `${path}/transitions`, {
        headers: { accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!offered.ok) {
        await offered.body?.cancel().catch(() => undefined);
        throw failureOf(offered.status);
      }
      const list = await jsonOf(offered);
      const transitions: { id: string; to: string; hasScreen: boolean }[] = [];
      if (isRecord(list) && Array.isArray(list.transitions))
        for (const transition of list.transitions as unknown[])
          if (
            isRecord(transition) &&
            typeof transition.id === "string" &&
            isRecord(transition.to) &&
            typeof transition.to.name === "string" &&
            transition.isAvailable !== false
          )
            transitions.push({
              id: transition.id,
              to: transition.to.name,
              hasScreen: transition.hasScreen === true,
            });
      // A transition without a screen first: one that needs fields cannot be done from here.
      const found = transitions
        .filter((transition) => transition.to.trim().toLowerCase() === wanted)
        .sort((a, b) => Number(a.hasScreen) - Number(b.hasScreen))[0];
      if (found === undefined) {
        const known = await deps.statuses.listStatuses(
          connectionId,
          projectKey,
        );
        if (
          known.ok &&
          !known.statuses.some(
            (candidate) => candidate.name.trim().toLowerCase() === wanted,
          )
        )
          return {
            kind: "status_unknown",
            available: known.statuses.map((candidate) => candidate.name),
          };
        return {
          kind: "status_unreachable",
          reachable: [...new Set(transitions.map((t) => t.to))],
        };
      }
      const moved = await call(
        connectionId,
        `${path}/transitions`,
        jsonInit("POST", { transition: { id: found.id } }, signal),
      );
      await moved.body?.cancel().catch(() => undefined);
      if (moved.status === 400)
        throw new TicketProviderError(
          "ticket_rejected",
          "Jira refused the transition: it may need a field of a screen that the factory cannot fill. Change the workflow so that the transition needs none.",
        );
      if (!moved.ok) throw failureOf(moved.status);
      return { kind: "moved", status: found.to };
    },
  };
}
