// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the app makes to Atlassian for the connection (#1037): the address of the consent page, the exchange of the code and the
// refresh of a token at the token endpoint, and the two lookups that follow a grant (the sites it covers, the account that granted it).
// Every call returns a value, never throws, and never carries a token, a response body or Atlassian's own error text into what it
// returns: a failure is `refused` (Atlassian said no to what was sent: the code, the refresh token, the access token) or `unavailable`
// (a timeout, a 5xx, a 429, an answer that is not what was expected). `fetch` and the timeout are parameters.
//
// PKCE is not used: Atlassian's 3LO flow for a web app authenticates the token request with the client secret and documents no
// `code_challenge`; the `state` is the protection of the round trip (src/signed-state/, single use, bound to person and session).
import { JIRA_SCOPES } from "./config.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type TokenGrant = {
  accessToken: string;
  /** The refresh token Atlassian rotated to; null when the answer holds none (the caller keeps the one it has). */
  refreshToken: string | null;
  expiresInSeconds: number;
  scopes: string[];
};

export type Failure = { ok: false; kind: "refused" | "unavailable" };
export type TokenResult = ({ ok: true } & TokenGrant) | Failure;

export type AtlassianSite = { id: string; url: string; name: string };
export type SitesResult = { ok: true; sites: AtlassianSite[] } | Failure;
export type AccountResult =
  { ok: true; account: { id: string; name: string } } | Failure;

export type AtlassianClient = {
  /** The address of the consent page for a state; the person goes there. */
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  exchangeCode(code: string, redirectUri: string): Promise<TokenResult>;
  refresh(refreshToken: string): Promise<TokenResult>;
  /** The Jira sites the grant covers. */
  sites(accessToken: string): Promise<SitesResult>;
  account(accessToken: string): Promise<AccountResult>;
  /** The base address of the Jira API of a site: `<api>/ex/jira/<cloudId>`. */
  jiraBase(cloudId: string): string;
  /** A request to Atlassian's API with a bearer token; `unavailable` when it could not be made. */
  send(
    url: string,
    accessToken: string,
    init?: RequestInit,
  ): Promise<Response | null>;
};

export type AtlassianClientOptions = {
  clientId: string;
  clientSecret: string;
  authBaseUrl: string;
  apiBaseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_TEXT = 200;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== ""
    ? value.slice(0, MAX_TEXT)
    : null;

export function createAtlassianClient({
  clientId,
  clientSecret,
  authBaseUrl,
  apiBaseUrl,
  fetchImpl = (url, init) => fetch(url, init),
  timeoutMs = 10_000,
}: AtlassianClientOptions): AtlassianClient {
  const auth = authBaseUrl.replace(/\/+$/, "");
  const api = apiBaseUrl.replace(/\/+$/, "");

  async function request(
    url: string,
    init: RequestInit,
  ): Promise<Response | null> {
    try {
      return await fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
  }

  async function json(response: Response): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  }

  /** The token endpoint, for both grant types. A 400, 401 or 403 is Atlassian saying no to what was sent. */
  async function token(body: Record<string, string>): Promise<TokenResult> {
    const response = await request(`${auth}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        ...body,
      }),
    });
    if (response === null) return { ok: false, kind: "unavailable" };
    if ([400, 401, 403].includes(response.status))
      return { ok: false, kind: "refused" };
    if (!response.ok) return { ok: false, kind: "unavailable" };
    const answer = await json(response);
    if (
      !isObject(answer) ||
      typeof answer.access_token !== "string" ||
      answer.access_token === "" ||
      typeof answer.expires_in !== "number" ||
      !Number.isFinite(answer.expires_in) ||
      answer.expires_in <= 0
    )
      return { ok: false, kind: "unavailable" };
    return {
      ok: true,
      accessToken: answer.access_token,
      refreshToken:
        typeof answer.refresh_token === "string" && answer.refresh_token !== ""
          ? answer.refresh_token
          : null,
      expiresInSeconds: answer.expires_in,
      scopes:
        typeof answer.scope === "string"
          ? answer.scope.split(/\s+/).filter(Boolean)
          : [],
    };
  }

  const bearer = (accessToken: string): RequestInit => ({
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });

  /** A GET of one lookup after a grant: 401 or 403 is a token Atlassian does not accept, anything else wrong is `unavailable`. */
  async function lookup(
    url: string,
    accessToken: string,
  ): Promise<{ ok: true; body: unknown } | Failure> {
    const response = await request(url, bearer(accessToken));
    if (response === null) return { ok: false, kind: "unavailable" };
    if (response.status === 401 || response.status === 403)
      return { ok: false, kind: "refused" };
    if (!response.ok) return { ok: false, kind: "unavailable" };
    const body = await json(response);
    return body === undefined
      ? { ok: false, kind: "unavailable" }
      : { ok: true, body };
  }

  return {
    authorizeUrl({ state, redirectUri }) {
      const url = new URL(`${auth}/authorize`);
      url.searchParams.set("audience", "api.atlassian.com");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("scope", JIRA_SCOPES.join(" "));
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      // Every connect shows the consent page, so the person chooses the sites again and a reconnect gets a fresh grant.
      url.searchParams.set("prompt", "consent");
      return url.toString();
    },

    exchangeCode: (code, redirectUri) =>
      token({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),

    refresh: (refreshToken) =>
      token({ grant_type: "refresh_token", refresh_token: refreshToken }),

    async sites(accessToken) {
      const result = await lookup(
        `${api}/oauth/token/accessible-resources`,
        accessToken,
      );
      if (!result.ok) return result;
      if (!Array.isArray(result.body))
        return { ok: false, kind: "unavailable" };
      const sites: AtlassianSite[] = [];
      for (const entry of result.body as unknown[]) {
        if (!isObject(entry)) continue;
        const id = text(entry.id);
        const url = text(entry.url);
        const name = text(entry.name);
        const scopes = Array.isArray(entry.scopes) ? entry.scopes : [];
        // The grant lists every product it reaches (Confluence too): only the Jira sites are connections.
        if (
          id === null ||
          url === null ||
          name === null ||
          !scopes.includes("read:jira-work")
        )
          continue;
        sites.push({ id, url, name });
      }
      return { ok: true, sites };
    },

    async account(accessToken) {
      const result = await lookup(`${api}/me`, accessToken);
      if (!result.ok) return result;
      const body = result.body;
      const id = isObject(body) ? text(body.account_id) : null;
      const name = isObject(body)
        ? (text(body.name) ?? text(body.email))
        : null;
      return id === null || name === null
        ? { ok: false, kind: "unavailable" }
        : { ok: true, account: { id, name } };
    },

    jiraBase: (cloudId) => `${api}/ex/jira/${encodeURIComponent(cloudId)}`,

    send: (url, accessToken, init = {}) =>
      request(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...(bearer(accessToken).headers as Record<string, string>),
        },
      }),
  };
}
