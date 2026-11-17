// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls to the authorization server's token endpoint (RFC 6749, 4.1.3 and 6): the exchange of the code (with the PKCE verifier, RFC 7636) and
// the refresh, both with the `resource` parameter (RFC 8707). The client authenticates the way it was registered (`none`, `client_secret_basic`,
// `client_secret_post`). The endpoint is guarded like every address of the flow (`endpoint-http.ts`).
//
// A failure is told apart by WHOSE it is, because only one of them is the grant's end:
//  - `refused`: `invalid_grant`. The code or the refresh token is revoked, expired, used or not the client's: the grant is over;
//  - `client`: the authorization server does not accept the OAuth client (`invalid_client`, `unauthorized_client`, a 401, any other 4xx error): a
//    wrong setting of the operator or of the person who entered the client. The grant may be fine: nothing is marked;
//  - `unavailable`: a timeout, a 5xx, an answer that is no token response, a body that is too large;
//  - `address_refused`: the endpoint is not an address this server calls.
// Nothing here logs a token, a secret, a body or an address.
import type {
  McpOAuthAuthMethod,
  McpOAuthDiscovery,
} from "../../db/repositories/mcp-oauth-repository.ts";
import { callEndpoint, jsonObject, type OAuthHttp } from "./endpoint-http.ts";

const TOKEN_MAX_LENGTH = 8192;
const DEFAULT_LIFETIME_SECONDS = 3600;
const MIN_LIFETIME_SECONDS = 30;
const MAX_LIFETIME_SECONDS = 30 * 24 * 3600;

export type OAuthClientAuth = {
  clientId: string;
  clientSecret: string | null;
  method: McpOAuthAuthMethod;
};

export type TokenGrant = {
  accessToken: string;
  /** Null when the authorization server issued none (a refresh keeps the one that was sent). */
  refreshToken: string | null;
  expiresInSeconds: number;
  /** The granted scopes; null when the answer does not say (the requested ones were granted). */
  scopes: string[] | null;
};

export type TokenFailureKind =
  "refused" | "client" | "unavailable" | "address_refused";

export type TokenResult =
  { ok: true; grant: TokenGrant } | { ok: false; kind: TokenFailureKind };

/** RFC 6749, appendix B: a form encoding of the id and the secret, then Basic. */
function basic(client: OAuthClientAuth): string {
  const encode = (value: string) =>
    encodeURIComponent(value).replace(/%20/g, "+");
  return `Basic ${Buffer.from(`${encode(client.clientId)}:${encode(client.clientSecret ?? "")}`).toString("base64")}`;
}

async function call(
  discovery: McpOAuthDiscovery,
  client: OAuthClientAuth,
  fields: [string, string][],
  http: OAuthHttp,
): Promise<TokenResult> {
  const form = new URLSearchParams(fields);
  form.set("resource", discovery.resource);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (client.method === "client_secret_basic" && client.clientSecret !== null)
    headers.authorization = basic(client);
  else {
    form.set("client_id", client.clientId);
    if (client.method === "client_secret_post" && client.clientSecret !== null)
      form.set("client_secret", client.clientSecret);
  }
  const answer = await callEndpoint(http, discovery.tokenEndpoint, {
    method: "POST",
    headers,
    body: form.toString(),
  });
  if (!answer.ok)
    return {
      ok: false,
      kind:
        answer.kind === "address_refused" ? "address_refused" : "unavailable",
    };
  if (answer.redirect) return { ok: false, kind: "unavailable" };
  const document = jsonObject(answer.text);
  if (answer.status !== 200) {
    if (answer.status >= 500 || answer.status < 400)
      return { ok: false, kind: "unavailable" };
    return {
      ok: false,
      kind: document?.error === "invalid_grant" ? "refused" : "client",
    };
  }
  if (document === undefined) return { ok: false, kind: "unavailable" };
  const { access_token: accessToken, refresh_token: refreshToken } = document;
  if (
    typeof accessToken !== "string" ||
    accessToken === "" ||
    accessToken.length > TOKEN_MAX_LENGTH ||
    typeof document.token_type !== "string" ||
    document.token_type.toLowerCase() !== "bearer" ||
    (refreshToken !== undefined &&
      refreshToken !== null &&
      (typeof refreshToken !== "string" ||
        refreshToken.length > TOKEN_MAX_LENGTH))
  )
    return { ok: false, kind: "unavailable" };
  const lifetime =
    typeof document.expires_in === "number" &&
    Number.isFinite(document.expires_in)
      ? Math.min(
          Math.max(Math.floor(document.expires_in), MIN_LIFETIME_SECONDS),
          MAX_LIFETIME_SECONDS,
        )
      : DEFAULT_LIFETIME_SECONDS;
  return {
    ok: true,
    grant: {
      accessToken,
      refreshToken:
        typeof refreshToken === "string" && refreshToken !== ""
          ? refreshToken
          : null,
      expiresInSeconds: lifetime,
      scopes:
        typeof document.scope === "string"
          ? document.scope.split(/\s+/).filter((scope) => scope !== "")
          : null,
    },
  };
}

export function exchangeCode(
  discovery: McpOAuthDiscovery,
  client: OAuthClientAuth,
  flow: { code: string; redirectUri: string; verifier: string },
  http: OAuthHttp,
): Promise<TokenResult> {
  return call(
    discovery,
    client,
    [
      ["grant_type", "authorization_code"],
      ["code", flow.code],
      ["redirect_uri", flow.redirectUri],
      ["code_verifier", flow.verifier],
    ],
    http,
  );
}

export function refreshGrant(
  discovery: McpOAuthDiscovery,
  client: OAuthClientAuth,
  refreshToken: string,
  http: OAuthHttp,
): Promise<TokenResult> {
  return call(
    discovery,
    client,
    [
      ["grant_type", "refresh_token"],
      ["refresh_token", refreshToken],
    ],
    http,
  );
}
