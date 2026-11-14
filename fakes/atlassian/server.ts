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
// What a test may do to it (`AtlassianFake`): choose the sites a consent covers, deny a consent, expire every access token, revoke every grant
// (the next refresh is refused, as when the person removed the app in their Atlassian account), and script the next answer of a path (a status,
// or a hang). It records every request but never a secret: whether the client credentials were right, and which grant type, yes; the secret and
// the tokens, no. `issuedTokens()` is the one way to read the tokens, for a test that looks for them in the app's answers, rows and logs.
// Dummy values only. Started by a test through `startAtlassianFake`.
import { randomBytes } from "node:crypto";
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
    const body = request.method === "POST" ? await readBody(request) : "";

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
    const jira = /^\/ex\/jira\/([^/]+)\/rest\/api\/3\/myself$/.exec(
      url.pathname,
    );
    if (request.method === "GET" && jira !== null) {
      if (!grant.sites.some((site) => site.id === jira[1]))
        return json(response, 404, { message: "no such site" }, entry);
      return json(
        response,
        200,
        { accountId: account.id, displayName: account.name },
        entry,
      );
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
