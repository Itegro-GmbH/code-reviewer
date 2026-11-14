// SPDX-License-Identifier: LicenseRef-Proprietary

// "Connect Jira" of a workspace (#1037, epic #1034): the OAuth 2.0 (3LO) round trip with the factory's own Atlassian app, the choice of
// the site, and the connections the workspace holds.
//
// 1. `startConnect` (an Owner or Admin): a signed state (`jira-connect`: the workspace, the person, a single-use nonce, 10 minutes, bound
//    to the browser session; for a reconnect it also names the connection) and the address of Atlassian's consent page.
// 2. Atlassian sends the browser to `<public URL>/api/jira/callback?code&state`. `completeCallback` uses the state up first (a wrong,
//    used, expired or foreign state refuses at once and nothing is exchanged), checks the person is still an Owner or Admin, exchanges
//    the code, reads the Jira sites the grant covers and the account that granted it:
//    - one site: the connection is saved (or the site's connection is renewed);
//    - several: the grant waits, sealed, in the workspace's secrets (`jira_pending_grant`, one per workspace, 15 minutes, for the
//      person who made it) and the page offers the choice (`readChoice`, `choose`); one OAuth round makes one connection, because
//      the tokens of a grant are one rotating pair: connecting another site is another round;
//    - none: `jira_no_site`;
//    - a reconnect names its connection: the grant must cover that site (`jira_site_mismatch` otherwise) and the connection gets
//      the new pair and is `connected` again.
// 3. `remove` forgets a connection unless a project uses it (`jira_connection_in_use`, the projects named).
//
// Tokens are sealed in the connection's row (src/jira/tokens.ts) and never leave the server: no answer, page, state, log line or error
// holds one. A state never carries an address; where the browser lands is a fixed page (http.ts).
import "server-only";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { createJiraConnectionsRepository } from "../db/repositories/jira-connections-repository.ts";
import type { StoredJiraConnection } from "../db/repositories/jira-connections-repository.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import { createWorkspaceSecretStore } from "../secrets/workspace-store.ts";
import type { SignedStates } from "../signed-state/state.ts";
import { can } from "../workspaces/permissions.ts";
import type { AtlassianClient, AtlassianSite } from "./client.ts";
import { jiraCallbackUrl, type AtlassianConfig } from "./config.ts";
import type { JiraErrorCode, JiraResultCode } from "./errors.ts";
import { hitJiraLimit } from "./rate-limits.ts";
import { sealPair } from "./tokens.ts";

/** How long a grant that covers several sites waits for the choice. */
export const PENDING_GRANT_TTL_MS = 15 * 60 * 1000;
const PENDING_NAME = "jira_pending_grant" as const;
const PENDING_BINDING = "jira_pending";

export type JiraActor = { id: string; sessionId: string };

export type StartResult =
  | { ok: true; url: string }
  | { ok: false; error: JiraErrorCode; retryAfterSeconds?: number };

export type CallbackResult = {
  /** The workspace the browser goes back to; null when the state could not name one the person administers. */
  workspaceId: string | null;
  code: JiraResultCode;
};

/** A connection as the page and the API show it: never a token. */
export type JiraConnectionView = {
  id: string;
  cloudId: string;
  siteUrl: string;
  siteName: string;
  accountName: string;
  scopes: string[];
  status: "connected" | "broken";
  /** Why it is broken (a code of `errors.ts`); null while connected. */
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SiteChoice = { cloudId: string; siteUrl: string; siteName: string };

export type RemoveResult =
  | { ok: true }
  | {
      ok: false;
      error: JiraErrorCode;
      projects?: { id: string; name: string }[];
    };

export type ChooseResult = { ok: true } | { ok: false; error: JiraErrorCode };

export type JiraService = {
  /** Whether "Connect Jira" can be offered (the Atlassian app's client id and secret are set). */
  available(): boolean;
  list(workspaceId: string): Promise<JiraConnectionView[]>;
  /** A new connection, or (with `connectionId`) the renewal of a broken or old one. */
  startConnect(
    actor: JiraActor,
    workspaceId: string,
    options?: { connectionId?: unknown },
  ): Promise<StartResult>;
  completeCallback(
    actor: JiraActor,
    query: { code: unknown; state: unknown; error: unknown },
  ): Promise<CallbackResult>;
  /** The sites of the person's waiting grant, or null when there is none (any more) for them. */
  readChoice(
    actor: JiraActor,
    workspaceId: string,
  ): Promise<SiteChoice[] | null>;
  choose(
    actor: JiraActor,
    workspaceId: string,
    choice: { cloudId: unknown },
  ): Promise<ChooseResult>;
  remove(
    actor: JiraActor,
    workspaceId: string,
    connectionId: string,
  ): Promise<RemoveResult>;
};

export type JiraServiceOptions = {
  db: Kysely<Database>;
  signedStates: SignedStates;
  rateLimits: RateLimitsRepository;
  client: AtlassianClient;
  /** The Atlassian settings, read on every call. */
  config: () => AtlassianConfig;
  /** The configured public address of the app: the callback address is made from it, never from a header. */
  publicUrl: string;
  /** The master key (`APP_SECRET`). */
  appSecret: string;
  now?: () => Date;
  log?: (line: string) => void;
};

type Pending = {
  userId: string;
  createdAt: number;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  account: { id: string; name: string };
  sites: AtlassianSite[];
};

const ID_LENGTH = 100;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function view(connection: StoredJiraConnection): JiraConnectionView {
  return {
    id: connection.id,
    cloudId: connection.cloudId,
    siteUrl: connection.siteUrl,
    siteName: connection.siteName,
    accountName: connection.accountName,
    scopes: connection.scopes,
    status: connection.status,
    errorCode: connection.errorCode,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/** The pending grant as stored text -> value; anything that is not one reads as none. */
function parsePending(text: string): Pending | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) return null;
    const { account, sites } = value;
    if (
      typeof value.userId !== "string" ||
      typeof value.createdAt !== "number" ||
      typeof value.accessToken !== "string" ||
      typeof value.refreshToken !== "string" ||
      typeof value.expiresAt !== "number" ||
      !Array.isArray(value.scopes) ||
      !isObject(account) ||
      typeof account.id !== "string" ||
      typeof account.name !== "string" ||
      !Array.isArray(sites)
    )
      return null;
    return value as Pending;
  } catch {
    return null;
  }
}

export function createJiraService({
  db,
  signedStates,
  rateLimits,
  client,
  config,
  publicUrl,
  appSecret,
  now = () => new Date(),
  log = (line) => console.error(line),
}: JiraServiceOptions): JiraService {
  const workspaces = createWorkspacesRepository(db, now);
  const redirectUri = jiraCallbackUrl(publicUrl);

  function repository(workspaceId: string) {
    return createJiraConnectionsRepository(db, workspaceId, now);
  }

  function pendingStore(workspaceId: string) {
    return createWorkspaceSecretStore<typeof PENDING_NAME>({
      db,
      workspaceId,
      appSecret,
      now,
    });
  }

  /** Whether the person is, now, an Owner or Admin of the workspace (read from the database every time). */
  async function administers(
    userId: string,
    workspaceId: string,
  ): Promise<boolean> {
    const membership = await workspaces.findMembershipById(userId, workspaceId);
    return (
      membership !== undefined && can(membership.role, "manage_connections")
    );
  }

  function done(
    workspaceId: string | null,
    code: JiraResultCode,
  ): CallbackResult {
    if (
      code !== "connected" &&
      code !== "reconnected" &&
      code !== "site_choice_ready"
    )
      log(`[jira] JIRA_REFUSED: ${code}`);
    return { workspaceId, code };
  }

  /**
   * Saves the grant as the connection to `site`: a connection of the same site is renewed in place. The tokens are sealed for the
   * row's id, so a row somebody made for the same site in the meantime (another id) makes this read it and seal again, once.
   */
  async function saveConnection(
    workspaceId: string,
    userId: string,
    site: AtlassianSite,
    grant: {
      accessToken: string;
      refreshToken: string;
      expiresAt: Date;
      scopes: string[];
      account: { id: string; name: string };
    },
  ): Promise<StoredJiraConnection | undefined> {
    const rows = repository(workspaceId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const id = (await rows.findBySite(site.id))?.id ?? randomUUID();
      const saved = await rows.save({
        id,
        cloudId: site.id,
        siteUrl: site.url,
        siteName: site.name,
        accountId: grant.account.id,
        accountName: grant.account.name,
        scopes: grant.scopes,
        sealed: sealPair(appSecret, id, {
          accessToken: grant.accessToken,
          refreshToken: grant.refreshToken,
        }),
        accessExpiresAt: grant.expiresAt,
        connectedBy: userId,
      });
      if (saved !== undefined) return saved;
    }
    return undefined;
  }

  return {
    available: () => config().configured,

    async list(workspaceId) {
      return (await repository(workspaceId).list()).map(view);
    },

    async startConnect(actor, workspaceId, options = {}) {
      if (!config().configured)
        return { ok: false, error: "jira_not_configured" };
      if (!(await administers(actor.id, workspaceId)))
        return { ok: false, error: "workspace_role_required" };
      let reconnectId: string | null = null;
      if (options.connectionId !== undefined) {
        if (
          typeof options.connectionId !== "string" ||
          options.connectionId === "" ||
          options.connectionId.length > ID_LENGTH ||
          (await repository(workspaceId).get(options.connectionId)) ===
            undefined
        )
          return { ok: false, error: "jira_connection_not_found" };
        reconnectId = options.connectionId;
      }
      const limit = await hitJiraLimit(rateLimits, "start", actor.id, now());
      if (!limit.allowed)
        return {
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: limit.retryAfterSeconds,
        };
      const state = await signedStates.issue({
        purpose: "jira-connect",
        userId: actor.id,
        sessionId: actor.sessionId,
        workspaceId,
        ...(reconnectId === null ? {} : { data: { reconnectId } }),
      });
      return { ok: true, url: client.authorizeUrl({ state, redirectUri }) };
    },

    async completeCallback(actor, query) {
      if (!config().configured) return done(null, "jira_not_configured");
      if (typeof query.state !== "string" || query.state === "")
        return done(null, "state_invalid");
      // The state is used up first: a forged, used, expired or foreign one ends here, before anything is asked of Atlassian.
      const consumed = await signedStates.consume({
        purpose: "jira-connect",
        value: query.state,
        userId: actor.id,
        sessionId: actor.sessionId,
      });
      if (!consumed.ok || consumed.workspaceId === null)
        return done(null, "state_invalid");
      const workspaceId = consumed.workspaceId;
      if (!(await administers(actor.id, workspaceId)))
        return done(null, "workspace_role_required");
      if (query.error !== undefined)
        return done(
          workspaceId,
          query.error === "access_denied"
            ? "access_denied"
            : "jira_authorization_refused",
        );
      if (
        typeof query.code !== "string" ||
        query.code === "" ||
        query.code.length > 2048
      )
        return done(workspaceId, "jira_authorization_refused");
      const limit = await hitJiraLimit(rateLimits, "callback", actor.id, now());
      if (!limit.allowed) return done(workspaceId, "rate_limited");

      const token = await client.exchangeCode(query.code, redirectUri);
      if (!token.ok)
        return done(
          workspaceId,
          token.kind === "refused"
            ? "jira_authorization_refused"
            : "jira_unreachable",
        );
      // Without a refresh token (no `offline_access`) the connection would end within the hour.
      if (token.refreshToken === null)
        return done(workspaceId, "jira_authorization_refused");
      const [sites, account] = await Promise.all([
        client.sites(token.accessToken),
        client.account(token.accessToken),
      ]);
      if (!sites.ok || !account.ok)
        return done(
          workspaceId,
          (!sites.ok && sites.kind === "refused") ||
            (!account.ok && account.kind === "refused")
            ? "jira_authorization_refused"
            : "jira_unreachable",
        );
      const grant = {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: new Date(now().getTime() + token.expiresInSeconds * 1000),
        scopes: token.scopes,
        account: account.account,
      };

      const reconnectId =
        isObject(consumed.data) && typeof consumed.data.reconnectId === "string"
          ? consumed.data.reconnectId
          : null;
      if (reconnectId !== null) {
        const existing = await repository(workspaceId).get(reconnectId);
        if (existing === undefined)
          return done(workspaceId, "jira_connection_not_found");
        const site = sites.sites.find((s) => s.id === existing.cloudId);
        if (site === undefined) return done(workspaceId, "jira_site_mismatch");
        const saved = await saveConnection(workspaceId, actor.id, site, grant);
        return done(
          workspaceId,
          saved === undefined ? "unavailable" : "reconnected",
        );
      }

      if (sites.sites.length === 0) return done(workspaceId, "jira_no_site");
      const only = sites.sites[0];
      if (sites.sites.length === 1 && only !== undefined) {
        const saved = await saveConnection(workspaceId, actor.id, only, grant);
        return done(
          workspaceId,
          saved === undefined ? "unavailable" : "connected",
        );
      }
      const pending: Pending = {
        userId: actor.id,
        createdAt: now().getTime(),
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        expiresAt: grant.expiresAt.getTime(),
        scopes: grant.scopes,
        account: grant.account,
        sites: sites.sites,
      };
      const stored = await pendingStore(workspaceId).save(
        PENDING_NAME,
        JSON.stringify(pending),
        { binding: PENDING_BINDING, updatedBy: actor.id },
      );
      return done(workspaceId, stored.ok ? "site_choice_ready" : "unavailable");
    },

    async readChoice(actor, workspaceId) {
      const waiting = await readPending(actor.id, workspaceId);
      return waiting === null
        ? null
        : waiting.sites.map((site) => ({
            cloudId: site.id,
            siteUrl: site.url,
            siteName: site.name,
          }));
    },

    async choose(actor, workspaceId, choice) {
      if (!(await administers(actor.id, workspaceId)))
        return { ok: false, error: "workspace_role_required" };
      const waiting = await readPending(actor.id, workspaceId);
      const site =
        typeof choice.cloudId === "string"
          ? waiting?.sites.find((s) => s.id === choice.cloudId)
          : undefined;
      if (waiting === null || site === undefined)
        return { ok: false, error: "jira_choice_invalid" };
      // The grant is one rotating token pair: it may be stored ONCE. It is taken in one statement, so of two clicks (or two tabs) only
      // one gets it; the other finds none. What was read above only decided that the choice is the person's and worth taking.
      const store = pendingStore(workspaceId);
      const taken = await store.take(PENDING_NAME);
      const grant = taken.ok ? parsePending(taken.value.reveal()) : null;
      if (
        grant === null ||
        grant.userId !== actor.id ||
        !grant.sites.some((s) => s.id === site.id)
      )
        return { ok: false, error: "jira_choice_invalid" };
      const keep = () =>
        store.save(PENDING_NAME, JSON.stringify(grant), {
          binding: PENDING_BINDING,
          updatedBy: actor.id,
        });
      let saved: StoredJiraConnection | undefined;
      try {
        saved = await saveConnection(workspaceId, actor.id, site, {
          accessToken: grant.accessToken,
          refreshToken: grant.refreshToken,
          expiresAt: new Date(grant.expiresAt),
          scopes: grant.scopes,
          account: grant.account,
        });
      } catch (error) {
        // Nothing was stored: the grant waits again for the next try.
        await keep();
        throw error;
      }
      if (saved === undefined) {
        await keep();
        return { ok: false, error: "unavailable" };
      }
      return { ok: true };
    },

    async remove(actor, workspaceId, connectionId) {
      if (!(await administers(actor.id, workspaceId)))
        return { ok: false, error: "workspace_role_required" };
      const result =
        await repository(workspaceId).removeUnlessUsed(connectionId);
      if (result.removed) return { ok: true };
      if (result.reason === "not_found")
        return { ok: false, error: "jira_connection_not_found" };
      return {
        ok: false,
        error: "jira_connection_in_use",
        projects: result.projects,
      };
    },
  };

  /** The waiting grant of this person, or null: none, another person's, older than the wait, or not readable (and then forgotten). */
  async function readPending(
    userId: string,
    workspaceId: string,
  ): Promise<Pending | null> {
    const store = pendingStore(workspaceId);
    const opened = await store.use(PENDING_NAME);
    if (!opened.ok) {
      if (opened.error !== "secret_not_configured")
        await store.remove(PENDING_NAME);
      return null;
    }
    const pending = parsePending(opened.value.reveal());
    if (
      pending === null ||
      now().getTime() - pending.createdAt > PENDING_GRANT_TTL_MS
    ) {
      await store.remove(PENDING_NAME);
      return null;
    }
    return pending.userId === userId ? pending : null;
  }
}
