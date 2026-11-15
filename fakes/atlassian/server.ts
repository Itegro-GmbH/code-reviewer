// SPDX-License-Identifier: LicenseRef-Proprietary

// A fake Atlassian (loopback only, in memory) for the tests of the Jira Cloud connection (#1037, epic #1034). One origin serves what the
// real service spreads over `auth.atlassian.com` and `api.atlassian.com`, in their shapes:
//   GET  /authorize                              the consent page: it "approves" and sends the browser back to `redirect_uri?code&state`
//                                                (or `error=access_denied`), after it checked what a real one checks (client, response type,
//                                                audience, scopes, an exact `redirect_uri` of the registered ones)
//   POST /oauth/token                            `authorization_code` (the code works once) and `refresh_token` with ROTATION: a refresh gives
//                                                a new access and a new refresh token and the old refresh token is dead from then on
//   GET  /oauth/token/accessible-resources       the sites the grant covers
//   GET  /me                                     the account that granted
//   GET  /ex/jira/<cloudId>/rest/api/3/myself    a Jira call: only a live access token of a grant that covers the site
//   GET  /ex/jira/<cloudId>/rest/api/3/project/search          the projects of a site, paged as Jira pages (`startAt`, `maxResults`, `isLast`)
//   GET  /ex/jira/<cloudId>/rest/api/3/project/<key>          one project by key or id (404 for an unknown one, as Jira also answers for a project the account cannot browse)
//   GET  /ex/jira/<cloudId>/rest/api/3/project/<key>/statuses  the workflow statuses of a project, by issue type (404 for an unknown key)
//   GET  /ex/jira/<cloudId>/rest/api/3/issue/<key>            one issue (REST shape, `fields` is not filtered); 404 for an unknown key (#1039)
//   POST /ex/jira/<cloudId>/rest/api/3/issue/<key>/comment    adds a comment (`body` is ADF; `properties`), authored by the account that granted (#1040)
//   PUT  /ex/jira/<cloudId>/rest/api/3/issue/<key>/comment/<id>  replaces the body (and the properties, when given) of a comment; 404 for an unknown one
//   GET  /ex/jira/<cloudId>/rest/api/3/issue/<key>/comment    the comments, paged (`startAt`, `maxResults`, `orderBy=-created`, `expand=properties`)
//   PUT  /ex/jira/<cloudId>/rest/api/3/issue/<key>            `update.labels` (`add`, `remove`) and `fields.labels`: a label with a space is refused (400) as Jira does
//   GET  /ex/jira/<cloudId>/rest/api/3/issue/<key>/transitions the transitions the workflow offers from the issue's status (`setTransitions`; by default every status of the project from any other)
//   POST /ex/jira/<cloudId>/rest/api/3/issue/<key>/transitions performs one by id (204); 400 when it needs fields (`requiresFields`) or is not offered
//   GET|POST /ex/jira/<cloudId>/rest/api/3/search/jql         JQL search, `project = KEY` only, paged by `nextPageToken` (`searchPageSize`), the issues in key order (#1040)
//   POST /ex/jira/<cloudId>/rest/api/3/webhook                registers dynamic webhooks (`url`, `webhooks[].jqlFilter`, `events`): a grant with
//                                                             `manage:jira-webhook` only, the clauses Jira supports, at most 5 per grant, 30 days of life
//   PUT  /ex/jira/<cloudId>/rest/api/3/webhook/refresh        extends the life of known webhooks by 30 days (`{ expirationDate }`); 404 when none is known
//   DELETE /ex/jira/<cloudId>/rest/api/3/webhook              deletes webhooks by `webhookIds` (unknown ids are ignored)
//   GET  /ex/jira/<cloudId>/rest/api/3/webhook                the webhooks of the app, paged (`values`, `isLast`)
// A test can also make the fake CALL a registered webhook (`deliver`): it posts the payload of an issue event to the registered address with the
// `X-Atlassian-Webhook-Identifier` header and, as Atlassian documents for OAuth 2.0 apps, a bearer token signed with the client secret.
// What a test may do to it (`AtlassianFake`): choose the sites a consent covers, deny a consent, expire every access token, revoke every grant
// (the next refresh is refused, as when the person removed the app in their Atlassian account), and script the next answer of a path (a status,
// or a hang). It records every request but never a secret: whether the client credentials were right, and which grant type, yes; the secret and
// the tokens, no. `issuedTokens()` is the one way to read the tokens, for a test that looks for them in the app's answers, rows and logs.
// Dummy values only. Started by a test through `startAtlassianFake`.
import { createHmac, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { keepConnectionsOpen } from "../keep-alive.ts";
import { isLoopbackHostname } from "../stripe/loopback.ts";

export const FAKE_ATLASSIAN_CLIENT_ID = "fake-atlassian-client-id";
export const FAKE_ATLASSIAN_CLIENT_SECRET = "fake-atlassian-client-secret";

export type FakeSite = {
  id: string;
  url: string;
  name: string;
  /** Default: the scopes the consent granted. */
  scopes?: string[];
};

/** A status of a Jira workflow, as `project/<key>/statuses` lists it. */
export type FakeJiraStatus = {
  id: string;
  name: string;
  /** `new`, `indeterminate` or `done`; default `indeterminate`. */
  category?: "new" | "indeterminate" | "done";
};

/** One issue type of a project with the statuses of its workflow. */
export type FakeIssueType = {
  id: string;
  name: string;
  statuses: FakeJiraStatus[];
};

/** A Jira project of a fake site. Without `issueTypes` it has one (Task) with To Do, In Progress and Done. */
export type FakeJiraProject = {
  id: string;
  key: string;
  name: string;
  projectTypeKey?: string;
  issueTypes?: FakeIssueType[];
};

/** An issue of a fake site, in the fields the factory reads. */
export type FakeJiraIssue = {
  id: string;
  key: string;
  summary: string;
  /** An ADF document or a plain string; default: none. */
  description?: unknown;
  status: { name: string; category?: "new" | "indeterminate" | "done" };
  issueType?: string;
  assignee?: { accountId: string; displayName: string };
  labels?: string[];
  parentKey?: string;
  /** ISO time of the last change; default: when it was set. */
  updated?: string;
};

/** A comment of an issue as the fake keeps it. */
export type FakeComment = {
  id: string;
  author: { accountId: string; displayName: string; accountType: string };
  /** ADF as it was written, or a string a test wrote. */
  body: unknown;
  properties: { key: string; value: unknown }[];
  created: string;
  updated: string;
};

/** A transition of the fake's workflow. `from` left out: from any status. */
export type FakeTransition = {
  id: string;
  name: string;
  /** The status the issue ends in. */
  to: string;
  from?: string[];
  /** The transition has a screen with required fields: performing it without them is a 400. */
  requiresFields?: boolean;
};

/** A webhook a test finds registered at the fake. */
export type FakeRegisteredWebhook = {
  id: number;
  cloudId: string;
  url: string;
  jql: string;
  events: string[];
  /** ISO. */
  expiresAt: string;
};

/** What `deliver` posts: an event of Jira about an issue of the site. */
export type FakeDelivery = {
  webhookEvent:
    | "jira:issue_created"
    | "jira:issue_updated"
    | "jira:issue_deleted"
    | "comment_created";
  issueKey: string;
  /** The changelog items of an update (`field`, `fromString`, `toString`). */
  changelog?: { field: string; fromString: string | null; toString: string }[];
  /** `X-Atlassian-Webhook-Identifier`; default: a new one for each delivery. */
  identifier?: string;
  /** `valid` (default): a JWT signed with the client secret; `none`: no Authorization header; `wrong`: signed with another secret. */
  bearer?: "valid" | "none" | "wrong";
  /** The address to call instead of the registered one (a test with a wrong secret). */
  url?: string;
  /** Milliseconds since the epoch; default: now. */
  timestamp?: number;
  /** The person who made the change. */
  user?: { accountId: string; displayName: string };
  /** For `comment_created`: the comment (default: a comment with the text "a comment"). `body` as ADF when `adf` is true, else as text. */
  comment?: {
    id?: string;
    body: string;
    adf?: boolean;
    author?: { accountId: string; displayName: string; accountType?: string };
  };
};

export type AtlassianFakeOptions = {
  clientId?: string;
  clientSecret?: string;
  /** The `redirect_uri` values the app registered; the consent refuses any other. Default: any. */
  redirectUris?: string[];
  /** The sites the person ticks at the consent (changeable with `setSites`). Default: one site. */
  sites?: FakeSite[];
  /** The Atlassian account that grants. */
  account?: { id: string; name: string; email: string };
  /** Seconds an access token lives, as `expires_in` says. Default 3600. */
  accessTokenSeconds?: number;
  /** The projects of each site by its id (changeable with `setProjects`). Default: none. */
  projects?: Record<string, FakeJiraProject[]>;
  /** How many projects one page of `project/search` holds at most. Default 50, as Jira's own default. */
  projectPageSize?: number;
  /** How many issues one page of `search/jql` holds at most (#1040). Default 100. */
  searchPageSize?: number;
  port?: number;
  host?: string;
};

export type RecordedRequest = {
  method: string;
  path: string;
  /** The query of a GET (`state`, `scope`, `redirect_uri`, ...); a token never travels there. */
  query: Record<string, string>;
  /** `authorization_code` or `refresh_token` for `/oauth/token`. */
  grantType: string | null;
  /** Whether the client id and secret of the token request were the registered ones. */
  clientAuthenticated: boolean | null;
  /** Whether the bearer token was a live access token. */
  bearerLive: boolean | null;
  status: number;
};

export type ScriptedAnswer =
  { status: number; body?: unknown } | { hang: true };

export type AtlassianFake = {
  /** The origin the app takes as both its auth and its API base: `http://127.0.0.1:<port>`. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  requests(): RecordedRequest[];
  /** The sites the next consents cover. */
  setSites(sites: FakeSite[]): void;
  /** The projects of a site (all of them, not only the ones the account may browse: the fake has no permissions per project). */
  setProjects(cloudId: string, projects: FakeJiraProject[]): void;
  /** The issues of a site (replaces them). */
  setIssues(cloudId: string, issues: FakeJiraIssue[]): void;
  /** Changes the status of an issue of a site (and its `updated`), as a person's transition would. */
  setIssueStatus(
    cloudId: string,
    key: string,
    status: FakeJiraIssue["status"],
  ): void;
  /** The comments of an issue, oldest first (#1040). */
  comments(cloudId: string, key: string): FakeComment[];
  /** A comment a person writes below an issue (not through the API): answers the comment, to be handed to `deliver`. */
  addComment(
    cloudId: string,
    key: string,
    comment: {
      body: string;
      author?: { accountId: string; displayName: string; accountType?: string };
    },
  ): FakeComment;
  /** The workflow's transitions of the site (replaces the default: every status of the project from any other). */
  setTransitions(cloudId: string, transitions: FakeTransition[]): void;
  /** The labels of an issue now. */
  labelsOf(cloudId: string, key: string): string[];
  /** The status name of an issue now. */
  statusOf(cloudId: string, key: string): string;
  /** The webhooks registered at the fake, in the order they were registered. */
  webhooks(): FakeRegisteredWebhook[];
  /** Changes when a webhook ends (ISO), for the test of the nightly extension. */
  setWebhookExpiry(id: number, expiresAt: string): void;
  /** Forgets a webhook, as when Jira lost it after three months without an extension. */
  dropWebhook(id: number): void;
  /**
   * Calls the registered webhook as Jira does (`POST`, JSON, the identifier header, the bearer token); answers what the receiver answered.
   * The body of the answer is read as JSON when it is.
   */
  deliver(
    webhookId: number,
    delivery: FakeDelivery,
  ): Promise<{ status: number; body: unknown; identifier: string }>;
  /** The next consent ends with `error=access_denied`. */
  denyNextConsent(): void;
  /** Every access token issued so far stops working (it "expired"); a refresh token still works. */
  expireAccessTokens(): void;
  /** Every grant is revoked: refreshing is refused from now on. */
  revokeGrants(): void;
  /** The next request to `path` (for example `/oauth/token`) gets this answer instead of the normal one. */
  failNext(path: string, answer: ScriptedAnswer): void;
  /**
   * The next accepted refresh is carried out (the token rotates) but its answer is held back until `release()`: another refresh that
   * arrives meanwhile sends a token that is already used up. `arrived` resolves when the held refresh has been carried out.
   */
  holdNextRefresh(): { arrived: Promise<void>; release(): void };
  /** Every access and refresh token handed out so far, for a test that looks for them somewhere they must not be. */
  issuedTokens(): string[];
  /** How many times a refresh token was accepted. */
  refreshes(): number;
  close(): Promise<void>;
};

type Grant = {
  id: string;
  scopes: string[];
  sites: FakeSite[];
  revoked: boolean;
  refreshToken: string;
};

const DEFAULT_ISSUE_TYPES: FakeIssueType[] = [
  {
    id: "10001",
    name: "Task",
    statuses: [
      { id: "10100", name: "To Do", category: "new" },
      { id: "10101", name: "In Progress", category: "indeterminate" },
      { id: "10102", name: "Done", category: "done" },
    ],
  },
];

const CATEGORY_NAMES = {
  new: "To Do",
  indeterminate: "In Progress",
  done: "Done",
} as const;

const TOKEN_FORMAT = (kind: string) =>
  `fake-${kind}-${randomBytes(12).toString("hex")}`;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export async function startAtlassianFake(
  options: AtlassianFakeOptions = {},
): Promise<AtlassianFake> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHostname(host))
    throw new Error(
      `The fake Atlassian only listens on a loopback address, not ${host}.`,
    );
  const clientId = options.clientId ?? FAKE_ATLASSIAN_CLIENT_ID;
  const clientSecret = options.clientSecret ?? FAKE_ATLASSIAN_CLIENT_SECRET;
  const account = options.account ?? {
    id: "712020:fake-account",
    name: "Ada Lovelace",
    email: "ada@example.test",
  };
  const accessSeconds = options.accessTokenSeconds ?? 3600;
  let sites: FakeSite[] = options.sites ?? [
    {
      id: "11111111-2222-3333-4444-555555555555",
      url: "https://acme.atlassian.net",
      name: "acme",
    },
  ];
  const projectsOfSite = new Map<string, FakeJiraProject[]>(
    Object.entries(options.projects ?? {}),
  );
  const projectPageSize = options.projectPageSize ?? 50;
  const searchPageSize = options.searchPageSize ?? 100;
  /** cloud id -> issue key -> comments, oldest first. */
  const commentsOfSite = new Map<string, Map<string, FakeComment[]>>();
  const transitionsOfSite = new Map<string, FakeTransition[]>();
  let nextCommentId = 10_000;
  const issuesOfSite = new Map<string, Map<string, FakeJiraIssue>>();
  const registeredWebhooks = new Map<
    number,
    FakeRegisteredWebhook & { grantId: string }
  >();
  let nextWebhookId = 1000;
  let nextIdentifier = 1;
  const WEBHOOK_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
  const WEBHOOKS_PER_GRANT = 5;
  let denyNext = false;
  const recorded: RecordedRequest[] = [];
  const scripted = new Map<string, ScriptedAnswer[]>();
  /** code -> what the consent granted. */
  const codes = new Map<
    string,
    { redirectUri: string; scopes: string[]; sites: FakeSite[]; used: boolean }
  >();
  const grants = new Map<string, Grant>();
  /** access token -> grant id, and whether it has "expired". */
  const accessTokens = new Map<string, { grantId: string; expired: boolean }>();
  /** refresh token -> grant id, while it is the current one of the grant. */
  const issued: string[] = [];
  let refreshCount = 0;
  const holds: { arrive: () => void; released: Promise<void> }[] = [];
  const open = new Set<ServerResponse>();

  function issue(grant: Grant, rotate: boolean) {
    const access = TOKEN_FORMAT("access");
    accessTokens.set(access, { grantId: grant.id, expired: false });
    issued.push(access);
    if (rotate) {
      grant.refreshToken = TOKEN_FORMAT("refresh");
      issued.push(grant.refreshToken);
    }
    return {
      access_token: access,
      expires_in: accessSeconds,
      scope: grant.scopes.join(" "),
      token_type: "Bearer",
      refresh_token: grant.refreshToken,
    };
  }

  function json(
    response: ServerResponse,
    status: number,
    body: unknown,
    entry: RecordedRequest,
  ) {
    entry.status = status;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  }

  function bearerOf(request: IncomingMessage): Grant | null {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const entry = accessTokens.get(token);
    if (entry === undefined || entry.expired) return null;
    const grant = grants.get(entry.grantId);
    return grant === undefined || grant.revoked ? null : grant;
  }

  const SUPPORTED_CLAUSES = [
    "issuekey",
    "project",
    "issuetype",
    "status",
    "priority",
    "assignee",
    "reporter",
  ];

  /** The REST shape of an issue, without `expand`. */
  function issueJson(issue: FakeJiraIssue, origin: string, cloudId: string) {
    const category = issue.status.category ?? "indeterminate";
    return {
      id: issue.id,
      key: issue.key,
      self: `${origin}/ex/jira/${cloudId}/rest/api/3/issue/${issue.id}`,
      fields: {
        summary: issue.summary,
        description: issue.description ?? null,
        status: {
          name: issue.status.name,
          statusCategory: { key: category, name: CATEGORY_NAMES[category] },
        },
        issuetype: { name: issue.issueType ?? "Task" },
        assignee: issue.assignee ?? null,
        labels: issue.labels ?? [],
        ...(issue.parentKey === undefined
          ? {}
          : { parent: { key: issue.parentKey } }),
        updated: (issue.updated ?? new Date().toISOString()).replace(
          /Z$/,
          "+0000",
        ),
      },
    };
  }

  const accountAuthor = () => ({
    accountId: account.id,
    displayName: account.name,
    accountType: "atlassian",
  });

  function commentList(cloudId: string, key: string): FakeComment[] {
    let issues = commentsOfSite.get(cloudId);
    if (issues === undefined) {
      issues = new Map();
      commentsOfSite.set(cloudId, issues);
    }
    let list = issues.get(key);
    if (list === undefined) {
      list = [];
      issues.set(key, list);
    }
    return list;
  }

  function newComment(
    cloudId: string,
    key: string,
    comment: Pick<FakeComment, "body" | "author"> &
      Partial<Pick<FakeComment, "properties">>,
  ): FakeComment {
    const now = new Date().toISOString();
    const created: FakeComment = {
      id: String(nextCommentId++),
      author: comment.author,
      body: comment.body,
      properties: comment.properties ?? [],
      created: now,
      updated: now,
    };
    commentList(cloudId, key).push(created);
    return created;
  }

  /** The statuses of the project an issue key belongs to: those of its issue types, each name once. */
  function statusesOfIssue(cloudId: string, key: string) {
    const projectKey = key.slice(0, key.lastIndexOf("-"));
    const project = (projectsOfSite.get(cloudId) ?? []).find(
      (candidate) => candidate.key === projectKey,
    );
    const seen = new Map<string, FakeJiraStatus>();
    for (const type of project?.issueTypes ?? DEFAULT_ISSUE_TYPES)
      for (const status of type.statuses)
        if (!seen.has(status.name)) seen.set(status.name, status);
    return [...seen.values()];
  }

  /** The transitions offered from the issue's current status. */
  function transitionsFor(cloudId: string, issue: FakeJiraIssue) {
    const configured = transitionsOfSite.get(cloudId);
    const all: FakeTransition[] =
      configured ??
      statusesOfIssue(cloudId, issue.key).map((status, index) => ({
        id: String(11 + index),
        name: `Move to ${status.name}`,
        to: status.name,
      }));
    return all.filter(
      (transition) =>
        transition.to !== issue.status.name &&
        (transition.from === undefined ||
          transition.from.includes(issue.status.name)),
    );
  }

  /** `project = KEY` (the clause the factory searches by), optionally quoted, optionally followed by `ORDER BY`. */
  function projectOfJql(jql: string): string | undefined {
    return /^\s*project\s*=\s*"?([A-Z][A-Z0-9_]*)"?\s*(?:order\s+by\s+[\w ,.]+)?\s*$/i.exec(
      jql,
    )?.[1];
  }

  const notFound = (response: ServerResponse, entry: RecordedRequest) =>
    json(
      response,
      404,
      {
        errorMessages: [
          "Issue does not exist or you do not have permission to see it.",
        ],
        errors: {},
      },
      entry,
    );

  /** What Jira offers below an issue (comments, labels, transitions) and the JQL search; true when the request was answered here. */
  function handleIssueApi(
    method: string,
    cloudId: string,
    path: string,
    url: URL,
    body: string,
    grant: Grant,
    response: ServerResponse,
    entry: RecordedRequest,
  ): boolean {
    const search = path === "/search/jql";
    const below =
      /^\/issue\/([^/]+)(\/comment|\/transitions)?(?:\/([^/]+))?$/.exec(path);
    if (!search && below === null) return false;
    if (!grant.sites.some((site) => site.id === cloudId)) {
      json(response, 404, { message: "no such site" }, entry);
      return true;
    }
    const write = method !== "GET" && !(search && method === "POST");
    if (write && !grant.scopes.includes("write:jira-work")) {
      json(response, 403, { message: "Forbidden" }, entry);
      return true;
    }
    let input: Record<string, unknown> = {};
    if (body !== "") {
      try {
        input = JSON.parse(body) as Record<string, unknown>;
      } catch {
        json(
          response,
          400,
          { errorMessages: ["Invalid JSON"], errors: {} },
          entry,
        );
        return true;
      }
    }
    const issues =
      issuesOfSite.get(cloudId) ?? new Map<string, FakeJiraIssue>();

    if (search) {
      if (method !== "GET" && method !== "POST") return false;
      const jql =
        method === "GET"
          ? (url.searchParams.get("jql") ?? "")
          : typeof input.jql === "string"
            ? input.jql
            : "";
      const projectKey = projectOfJql(jql);
      if (projectKey === undefined) {
        json(
          response,
          400,
          {
            errorMessages: [
              `Error in the JQL Query: unsupported in the fake: ${jql.slice(0, 80)}`,
            ],
            errors: {},
          },
          entry,
        );
        return true;
      }
      const token =
        method === "GET"
          ? url.searchParams.get("nextPageToken")
          : typeof input.nextPageToken === "string"
            ? input.nextPageToken
            : null;
      const asked =
        method === "GET"
          ? Number(url.searchParams.get("maxResults") ?? searchPageSize)
          : typeof input.maxResults === "number"
            ? input.maxResults
            : searchPageSize;
      const offset = token === null ? 0 : Number(token);
      const size = Math.max(1, Math.min(asked, searchPageSize));
      const matching = [...issues.values()].filter((issue) =>
        issue.key.startsWith(`${projectKey}-`),
      );
      const page = matching.slice(offset, offset + size);
      const more = offset + page.length < matching.length;
      json(
        response,
        200,
        {
          issues: page.map((issue) => issueJson(issue, url.origin, cloudId)),
          ...(more ? { nextPageToken: String(offset + page.length) } : {}),
          isLast: !more,
        },
        entry,
      );
      return true;
    }

    const key = decodeURIComponent(below?.[1] ?? "");
    const kind = below?.[2];
    const id = below?.[3];
    const issue = issues.get(key);

    if (kind === undefined) {
      // PUT /issue/<key>: the labels (the only edit the factory makes).
      if (method !== "PUT" || id !== undefined) return false;
      if (issue === undefined) {
        notFound(response, entry);
        return true;
      }
      const update = (input.update ?? {}) as { labels?: unknown };
      const fields = (input.fields ?? {}) as { labels?: unknown };
      const labels = new Set(issue.labels ?? []);
      const operations: { add?: string; remove?: string }[] = [];
      if (Array.isArray(update.labels))
        operations.push(
          ...(update.labels as { add?: string; remove?: string }[]),
        );
      if (Array.isArray(fields.labels)) {
        labels.clear();
        for (const label of fields.labels as string[])
          operations.push({ add: label });
      }
      for (const operation of operations)
        for (const label of [operation.add, operation.remove])
          if (typeof label === "string" && /\s/.test(label)) {
            json(
              response,
              400,
              {
                errorMessages: [],
                errors: { labels: `The label '${label}' contains spaces.` },
              },
              entry,
            );
            return true;
          }
      for (const operation of operations) {
        if (typeof operation.add === "string") labels.add(operation.add);
        if (typeof operation.remove === "string")
          labels.delete(operation.remove);
      }
      issue.labels = [...labels];
      issue.updated = new Date().toISOString();
      response.writeHead(204);
      response.end();
      entry.status = 204;
      return true;
    }

    if (issue === undefined) {
      notFound(response, entry);
      return true;
    }

    if (kind === "/transitions") {
      if (id !== undefined) return false;
      if (method === "GET") {
        json(
          response,
          200,
          {
            transitions: transitionsFor(cloudId, issue).map((transition) => {
              const target = statusesOfIssue(cloudId, key).find(
                (status) => status.name === transition.to,
              );
              return {
                id: transition.id,
                name: transition.name,
                to: {
                  id: target?.id ?? "0",
                  name: transition.to,
                  statusCategory: {
                    key: target?.category ?? "indeterminate",
                  },
                },
                hasScreen: transition.requiresFields === true,
                isAvailable: true,
              };
            }),
          },
          entry,
        );
        return true;
      }
      if (method === "POST") {
        const chosen = (input.transition ?? {}) as { id?: unknown };
        const transition = transitionsFor(cloudId, issue).find(
          (candidate) => candidate.id === chosen.id,
        );
        if (transition === undefined) {
          json(
            response,
            400,
            {
              errorMessages: ["Invalid transition: it is not available."],
              errors: {},
            },
            entry,
          );
          return true;
        }
        if (transition.requiresFields === true && input.fields === undefined) {
          json(
            response,
            400,
            {
              errorMessages: [],
              errors: { resolution: "Field 'resolution' is required" },
            },
            entry,
          );
          return true;
        }
        const target = statusesOfIssue(cloudId, key).find(
          (status) => status.name === transition.to,
        );
        issue.status = {
          name: transition.to,
          ...(target?.category === undefined
            ? {}
            : { category: target.category }),
        };
        issue.updated = new Date().toISOString();
        response.writeHead(204);
        response.end();
        entry.status = 204;
        return true;
      }
      return false;
    }

    // Comments.
    const list = commentList(cloudId, key);
    const commentJson = (comment: FakeComment, withProperties: boolean) => ({
      id: comment.id,
      self: `${url.origin}/ex/jira/${cloudId}/rest/api/3/issue/${issue.id}/comment/${comment.id}`,
      author: comment.author,
      body: comment.body,
      created: comment.created.replace(/Z$/, "+0000"),
      updated: comment.updated.replace(/Z$/, "+0000"),
      ...(withProperties ? { properties: comment.properties } : {}),
    });
    if (id === undefined && method === "POST") {
      const created = newComment(cloudId, key, {
        body: input.body,
        author: accountAuthor(),
        properties: Array.isArray(input.properties)
          ? (input.properties as FakeComment["properties"])
          : [],
      });
      json(response, 201, commentJson(created, false), entry);
      return true;
    }
    if (id === undefined && method === "GET") {
      const startAt = Math.max(0, Number(url.searchParams.get("startAt") ?? 0));
      const size = Math.max(
        1,
        Math.min(Number(url.searchParams.get("maxResults") ?? 50), 100),
      );
      const newestFirst = url.searchParams.get("orderBy") === "-created";
      const ordered = newestFirst ? [...list].reverse() : [...list];
      const withProperties = (url.searchParams.get("expand") ?? "")
        .split(",")
        .includes("properties");
      json(
        response,
        200,
        {
          startAt,
          maxResults: size,
          total: ordered.length,
          comments: ordered
            .slice(startAt, startAt + size)
            .map((comment) => commentJson(comment, withProperties)),
        },
        entry,
      );
      return true;
    }
    if (id !== undefined && method === "PUT") {
      const comment = list.find((candidate) => candidate.id === id);
      if (comment === undefined) {
        json(
          response,
          404,
          {
            errorMessages: ["Can't find a comment with the id " + id],
            errors: {},
          },
          entry,
        );
        return true;
      }
      comment.body = input.body;
      if (Array.isArray(input.properties))
        comment.properties = input.properties as FakeComment["properties"];
      comment.updated = new Date().toISOString();
      json(response, 200, commentJson(comment, false), entry);
      return true;
    }
    return false;
  }

  function handleWebhookApi(
    method: string,
    cloudId: string,
    path: string,
    url: URL,
    body: string,
    grant: Grant,
    response: ServerResponse,
    entry: RecordedRequest,
  ) {
    if (!grant.sites.some((site) => site.id === cloudId))
      return json(response, 404, { message: "no such site" }, entry);
    if (!grant.scopes.includes("manage:jira-webhook"))
      return json(response, 403, { message: "Forbidden" }, entry);
    let input: Record<string, unknown> = {};
    if (body !== "") {
      try {
        input = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return json(
          response,
          400,
          { errorMessages: ["Invalid JSON"], errors: {} },
          entry,
        );
      }
    }
    const ids = Array.isArray(input.webhookIds)
      ? input.webhookIds.filter((id): id is number => typeof id === "number")
      : [];
    const mine = () =>
      [...registeredWebhooks.values()].filter(
        (hook) => hook.grantId === grant.id,
      );
    const expiry = (hook: FakeRegisteredWebhook) =>
      hook.expiresAt.replace(/Z$/, "+0000");

    if (method === "POST" && path === "/webhook") {
      const address = typeof input.url === "string" ? input.url : "";
      if (!/^https?:\/\//.test(address))
        return json(
          response,
          400,
          { errorMessages: ["The url must be https"], errors: {} },
          entry,
        );
      const results: Record<string, unknown>[] = [];
      for (const webhook of Array.isArray(input.webhooks)
        ? input.webhooks
        : []) {
        const jql =
          typeof webhook?.jqlFilter === "string" ? webhook.jqlFilter : "";
        const events: string[] = Array.isArray(webhook?.events)
          ? webhook.events
          : [];
        const clause = /^\s*([A-Za-z.]+)\s*(=|!=|IN|NOT IN)\s*\S+/i.exec(jql);
        if (
          clause === null ||
          !SUPPORTED_CLAUSES.includes((clause[1] ?? "").toLowerCase())
        ) {
          results.push({
            errors: [`The clause ${clause?.[1] ?? jql} is unsupported`],
          });
          continue;
        }
        if (mine().length >= WEBHOOKS_PER_GRANT) {
          results.push({
            errors: [
              `You can only register ${String(WEBHOOKS_PER_GRANT)} webhooks per app and user on a site`,
            ],
          });
          continue;
        }
        nextWebhookId += 1;
        registeredWebhooks.set(nextWebhookId, {
          id: nextWebhookId,
          cloudId,
          url: address,
          jql,
          events,
          expiresAt: new Date(Date.now() + WEBHOOK_LIFE_MS).toISOString(),
          grantId: grant.id,
        });
        results.push({ createdWebhookId: nextWebhookId });
      }
      return json(response, 200, { webhookRegistrationResult: results }, entry);
    }
    if (method === "PUT" && path === "/webhook/refresh") {
      const known = ids.filter(
        (id) => registeredWebhooks.get(id)?.grantId === grant.id,
      );
      if (known.length === 0)
        return json(
          response,
          404,
          { errorMessages: ["No such webhook"], errors: {} },
          entry,
        );
      let expirationDate = "";
      for (const id of known) {
        const hook = registeredWebhooks.get(id);
        if (hook === undefined) continue;
        hook.expiresAt = new Date(Date.now() + WEBHOOK_LIFE_MS).toISOString();
        expirationDate = expiry(hook);
      }
      return json(response, 200, { expirationDate }, entry);
    }
    if (method === "DELETE" && path === "/webhook") {
      for (const id of ids)
        if (registeredWebhooks.get(id)?.grantId === grant.id)
          registeredWebhooks.delete(id);
      return json(response, 202, {}, entry);
    }
    if (method === "GET" && path === "/webhook") {
      const startAt = Math.max(0, Number(url.searchParams.get("startAt") ?? 0));
      const maxResults = Math.max(
        1,
        Number(url.searchParams.get("maxResults") ?? 100),
      );
      const all = mine();
      const page = all.slice(startAt, startAt + maxResults);
      return json(
        response,
        200,
        {
          values: page.map((hook) => ({
            id: hook.id,
            jqlFilter: hook.jql,
            events: hook.events,
            expirationDate: expiry(hook),
          })),
          startAt,
          maxResults,
          total: all.length,
          isLast: startAt + page.length >= all.length,
        },
        entry,
      );
    }
    return json(response, 404, { error: "not_found" }, entry);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://fake");
    const entry: RecordedRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      grantType: null,
      clientAuthenticated: null,
      bearerLive: null,
      status: 0,
    };
    recorded.push(entry);
    open.add(response);
    response.on("close", () => open.delete(response));
    const body = ["POST", "PUT", "DELETE"].includes(request.method ?? "")
      ? await readBody(request)
      : "";

    const script = scripted.get(url.pathname)?.shift();
    if (script !== undefined) {
      if ("hang" in script) return;
      return json(response, script.status, script.body ?? {}, entry);
    }

    if (request.method === "GET" && url.pathname === "/authorize") {
      const q = url.searchParams;
      const redirectUri = q.get("redirect_uri") ?? "";
      const scopes = (q.get("scope") ?? "").split(/\s+/).filter(Boolean);
      const state = q.get("state");
      const problem =
        q.get("client_id") !== clientId
          ? "unknown client_id"
          : q.get("response_type") !== "code"
            ? "response_type must be code"
            : q.get("audience") !== "api.atlassian.com"
              ? "audience must be api.atlassian.com"
              : state === null || state === ""
                ? "state is missing"
                : scopes.length === 0
                  ? "scope is missing"
                  : options.redirectUris !== undefined &&
                      !options.redirectUris.includes(redirectUri)
                    ? "redirect_uri is not registered"
                    : null;
      if (problem !== null)
        return json(response, 400, { error: problem }, entry);
      const target = new URL(redirectUri);
      target.searchParams.set("state", state ?? "");
      if (denyNext) {
        denyNext = false;
        target.searchParams.set("error", "access_denied");
      } else {
        const code = TOKEN_FORMAT("code");
        codes.set(code, {
          redirectUri,
          scopes,
          sites: [...sites],
          used: false,
        });
        target.searchParams.set("code", code);
      }
      entry.status = 302;
      response.writeHead(302, { location: target.toString() });
      return void response.end();
    }

    if (request.method === "POST" && url.pathname === "/oauth/token") {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return json(response, 400, { error: "invalid_request" }, entry);
      }
      entry.grantType =
        typeof input.grant_type === "string" ? input.grant_type : null;
      entry.clientAuthenticated =
        input.client_id === clientId && input.client_secret === clientSecret;
      if (!entry.clientAuthenticated)
        return json(response, 401, { error: "access_denied" }, entry);
      if (input.grant_type === "authorization_code") {
        const code = codes.get(String(input.code));
        if (
          code === undefined ||
          code.used ||
          code.redirectUri !== input.redirect_uri
        )
          return json(response, 403, { error: "invalid_grant" }, entry);
        code.used = true;
        const grant: Grant = {
          id: TOKEN_FORMAT("grant"),
          scopes: code.scopes,
          sites: code.sites,
          revoked: false,
          refreshToken: "",
        };
        grants.set(grant.id, grant);
        return json(response, 200, issue(grant, true), entry);
      }
      if (input.grant_type === "refresh_token") {
        const grant = [...grants.values()].find(
          (g) => g.refreshToken === input.refresh_token,
        );
        if (grant === undefined || grant.revoked)
          return json(
            response,
            403,
            {
              error: "invalid_grant",
              error_description: "Unknown or invalid refresh token.",
            },
            entry,
          );
        refreshCount += 1;
        const answer = issue(grant, true);
        const held = holds.shift();
        if (held !== undefined) {
          held.arrive();
          await held.released;
        }
        return json(response, 200, answer, entry);
      }
      return json(response, 400, { error: "unsupported_grant_type" }, entry);
    }

    const grant = bearerOf(request);
    entry.bearerLive = grant !== null;
    if (grant === null)
      return json(response, 401, { code: 401, message: "Unauthorized" }, entry);

    if (
      request.method === "GET" &&
      url.pathname === "/oauth/token/accessible-resources"
    )
      return json(
        response,
        200,
        grant.sites.map((site) => ({
          id: site.id,
          url: site.url,
          name: site.name,
          scopes: site.scopes ?? grant.scopes,
          avatarUrl: `${site.url}/avatar.png`,
        })),
        entry,
      );
    if (request.method === "GET" && url.pathname === "/me")
      return json(
        response,
        200,
        { account_id: account.id, name: account.name, email: account.email },
        entry,
      );
    const jira = /^\/ex\/jira\/([^/]+)\/rest\/api\/3(\/.*)$/.exec(url.pathname);
    if (jira !== null && url.pathname.includes("/webhook"))
      return handleWebhookApi(
        request.method ?? "GET",
        jira[1] ?? "",
        jira[2] ?? "",
        url,
        body,
        grant,
        response,
        entry,
      );
    if (
      jira !== null &&
      handleIssueApi(
        request.method ?? "GET",
        jira[1] ?? "",
        jira[2] ?? "",
        url,
        body,
        grant,
        response,
        entry,
      )
    )
      return;
    if (request.method === "GET" && jira !== null) {
      const cloudId = jira[1] ?? "";
      const path = jira[2] ?? "";
      if (!grant.sites.some((site) => site.id === cloudId))
        return json(response, 404, { message: "no such site" }, entry);
      const issueMatch = /^\/issue\/([^/]+)$/.exec(path);
      if (issueMatch !== null) {
        const issue = issuesOfSite
          .get(cloudId)
          ?.get(decodeURIComponent(issueMatch[1] ?? ""));
        if (issue === undefined)
          return json(
            response,
            404,
            {
              errorMessages: [
                "Issue does not exist or you do not have permission to see it.",
              ],
              errors: {},
            },
            entry,
          );
        return json(
          response,
          200,
          issueJson(issue, url.origin, cloudId),
          entry,
        );
      }
      if (path === "/myself")
        return json(
          response,
          200,
          { accountId: account.id, displayName: account.name },
          entry,
        );
      const projects = projectsOfSite.get(cloudId) ?? [];
      if (path === "/project/search") {
        const startAt = Math.max(
          0,
          Number(url.searchParams.get("startAt") ?? 0),
        );
        const asked = Number(
          url.searchParams.get("maxResults") ?? projectPageSize,
        );
        const size = Math.max(1, Math.min(asked, projectPageSize));
        const page = projects.slice(startAt, startAt + size);
        return json(
          response,
          200,
          {
            self: `${url.origin}${url.pathname}`,
            startAt,
            maxResults: size,
            total: projects.length,
            isLast: startAt + page.length >= projects.length,
            values: page.map((project) => ({
              id: project.id,
              key: project.key,
              name: project.name,
              projectTypeKey: project.projectTypeKey ?? "software",
              simplified: false,
              style: "classic",
            })),
          },
          entry,
        );
      }
      const single = /^\/project\/([^/]+)$/.exec(path);
      if (single !== null && single[1] !== "search") {
        const key = decodeURIComponent(single[1] ?? "");
        const project = projects.find(
          (candidate) => candidate.key === key || candidate.id === key,
        );
        if (project === undefined)
          return json(
            response,
            404,
            {
              errorMessages: ["No project could be found with key."],
              errors: {},
            },
            entry,
          );
        return json(
          response,
          200,
          {
            id: project.id,
            key: project.key,
            name: project.name,
            projectTypeKey: project.projectTypeKey ?? "software",
            simplified: false,
            style: "classic",
          },
          entry,
        );
      }
      const statuses = /^\/project\/([^/]+)\/statuses$/.exec(path);
      if (statuses !== null) {
        const key = decodeURIComponent(statuses[1] ?? "");
        const project = projects.find(
          (candidate) => candidate.key === key || candidate.id === key,
        );
        if (project === undefined)
          return json(
            response,
            404,
            {
              errorMessages: ["No project could be found with key."],
              errors: {},
            },
            entry,
          );
        return json(
          response,
          200,
          (project.issueTypes ?? DEFAULT_ISSUE_TYPES).map((type) => ({
            id: type.id,
            name: type.name,
            subtask: false,
            statuses: type.statuses.map((status) => ({
              id: status.id,
              name: status.name,
              statusCategory: {
                key: status.category ?? "indeterminate",
                name: CATEGORY_NAMES[status.category ?? "indeterminate"],
              },
            })),
          })),
          entry,
        );
      }
    }
    return json(response, 404, { error: "not_found" }, entry);
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  keepConnectionsOpen(server);
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, host, resolve),
  );
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://${host}:${port}`,
    clientId,
    clientSecret,
    requests: () => structuredClone(recorded),
    setSites(next) {
      sites = [...next];
    },
    setProjects(cloudId, next) {
      projectsOfSite.set(cloudId, [...next]);
    },
    setIssues(cloudId, issues) {
      issuesOfSite.set(
        cloudId,
        new Map(issues.map((issue) => [issue.key, { ...issue }])),
      );
    },
    comments: (cloudId, key) =>
      structuredClone(commentsOfSite.get(cloudId)?.get(key) ?? []),
    addComment(cloudId, key, comment) {
      const created = newComment(cloudId, key, {
        body: comment.body,
        author: {
          ...(comment.author ?? {
            accountId: "712020:a-person",
            displayName: "A Person",
          }),
          accountType: comment.author?.accountType ?? "atlassian",
        },
      });
      return structuredClone(created);
    },
    setTransitions(cloudId, transitions) {
      transitionsOfSite.set(cloudId, [...transitions]);
    },
    labelsOf: (cloudId, key) => [
      ...(issuesOfSite.get(cloudId)?.get(key)?.labels ?? []),
    ],
    statusOf(cloudId, key) {
      const issue = issuesOfSite.get(cloudId)?.get(key);
      if (issue === undefined) throw new Error(`No issue ${key} in the fake.`);
      return issue.status.name;
    },
    setIssueStatus(cloudId, key, status) {
      const issue = issuesOfSite.get(cloudId)?.get(key);
      if (issue === undefined) throw new Error(`No issue ${key} in the fake.`);
      issue.status = status;
      issue.updated = new Date().toISOString();
    },
    webhooks: () =>
      [...registeredWebhooks.values()].map(
        ({ grantId: _grantId, ...hook }) => ({
          ...hook,
          events: [...hook.events],
        }),
      ),
    setWebhookExpiry(id, expiresAt) {
      const hook = registeredWebhooks.get(id);
      if (hook === undefined)
        throw new Error(`No webhook ${String(id)} in the fake.`);
      hook.expiresAt = expiresAt;
    },
    dropWebhook(id) {
      registeredWebhooks.delete(id);
    },
    async deliver(webhookId, delivery) {
      const hook = registeredWebhooks.get(webhookId);
      if (hook === undefined)
        throw new Error(`No webhook ${String(webhookId)} in the fake.`);
      const issue = issuesOfSite.get(hook.cloudId)?.get(delivery.issueKey);
      if (issue === undefined)
        throw new Error(`No issue ${delivery.issueKey} in the fake.`);
      const timestamp = delivery.timestamp ?? Date.now();
      const identifier =
        delivery.identifier ?? `fake-delivery-${String(nextIdentifier++)}`;
      const payload = {
        timestamp,
        webhookEvent: delivery.webhookEvent,
        issue_event_type_name: "issue_generic",
        user: delivery.user ?? {
          accountId: account.id,
          displayName: account.name,
        },
        issue: issueJson(issue, `http://${host}`, hook.cloudId),
        ...(delivery.webhookEvent === "jira:issue_updated"
          ? { changelog: { id: "1", items: delivery.changelog ?? [] } }
          : {}),
        ...(delivery.webhookEvent === "comment_created"
          ? {
              comment: {
                id: delivery.comment?.id ?? "1",
                author: delivery.comment?.author ?? {
                  accountId: "712020:a-person",
                  displayName: "A Person",
                  accountType: "atlassian",
                },
                body:
                  delivery.comment?.adf === true
                    ? {
                        version: 1,
                        type: "doc",
                        content: [
                          {
                            type: "paragraph",
                            content: [
                              { type: "text", text: delivery.comment.body },
                            ],
                          },
                        ],
                      }
                    : (delivery.comment?.body ?? "a comment"),
                created: new Date(timestamp)
                  .toISOString()
                  .replace(/Z$/, "+0000"),
                updated: new Date(timestamp)
                  .toISOString()
                  .replace(/Z$/, "+0000"),
              },
            }
          : {}),
        matchedWebhookIds: [webhookId],
      };
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-atlassian-webhook-identifier": identifier,
        "x-atlassian-webhook-flow": "Primary",
      };
      const bearer = delivery.bearer ?? "valid";
      if (bearer !== "none") {
        const head = Buffer.from(
          JSON.stringify({ alg: "HS256", typ: "JWT" }),
        ).toString("base64url");
        const claims = Buffer.from(
          JSON.stringify({
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 300,
          }),
        ).toString("base64url");
        const signature = createHmac(
          "sha256",
          bearer === "wrong" ? "another-secret" : clientSecret,
        )
          .update(`${head}.${claims}`)
          .digest("base64url");
        headers.authorization = `Bearer ${head}.${claims}.${signature}`;
      }
      const result = await fetch(delivery.url ?? hook.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const text = await result.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON: the text stays
      }
      return { status: result.status, body: parsed, identifier };
    },
    denyNextConsent() {
      denyNext = true;
    },
    expireAccessTokens() {
      for (const token of accessTokens.values()) token.expired = true;
    },
    revokeGrants() {
      for (const grant of grants.values()) grant.revoked = true;
    },
    failNext(path, answer) {
      scripted.set(path, [...(scripted.get(path) ?? []), answer]);
    },
    holdNextRefresh() {
      let arrive: () => void = () => undefined;
      let release: () => void = () => undefined;
      const arrived = new Promise<void>((resolve) => (arrive = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      holds.push({ arrive, released });
      return { arrived, release };
    },
    issuedTokens: () => [...issued],
    refreshes: () => refreshCount,
    async close() {
      for (const response of open) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
