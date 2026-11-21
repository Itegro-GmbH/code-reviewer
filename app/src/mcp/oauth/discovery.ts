// SPDX-License-Identifier: LicenseRef-Proprietary

// Discovery of the authorization server of a remote MCP server (#1051), the way the MCP authorization specification and the RFCs under it say:
//
//  1. An unauthenticated request to the MCP server is answered `401` with `WWW-Authenticate: Bearer resource_metadata="<url>", scope="..."`
//     (RFC 9728, section 5.1). Without that parameter the well-known places are tried: `/.well-known/oauth-protected-resource` with the path of
//     the server after it, then without the path.
//  2. The protected-resource metadata names the `resource` (it must be the address of this server: a document found at the server's own address
//     that claims another resource is refused) and its `authorization_servers`. The first one is used.
//  3. The authorization server's metadata is read from RFC 8414 (`/.well-known/oauth-authorization-server`) or OpenID Connect discovery
//     (`/.well-known/openid-configuration`), inserted before the issuer's path or appended to it, in the order the MCP specification gives. Its
//     `issuer` must be the issuer it was found for. It must list the code challenge method S256 (a client must not go on without PKCE) and have an
//     authorization and a token endpoint.
//
// Every address (the one in the header, the metadata, the issuer, each endpoint) goes through the guard of `endpoint-http.ts`, and the
// authorization server may be on another origin than the server: it is checked, not assumed. Nothing here keeps or logs a body or an address; a
// failure is one stable code (`errors.ts`).
import type { McpOAuthDiscovery } from "../../db/repositories/mcp-oauth-repository.ts";
import type { McpTransport } from "../input.ts";
import { MCP_PROTOCOL_VERSION } from "../client.ts";
import {
  addressAllowed,
  callEndpoint,
  jsonObject,
  type CallFailure,
  type OAuthHttp,
} from "./endpoint-http.ts";
import type { McpOAuthFailureCode } from "./errors.ts";

export type DiscoveryTarget = { url: string; transport: McpTransport };

export type DiscoveryResult =
  | { ok: true; discovery: McpOAuthDiscovery }
  | {
      ok: false;
      code: Extract<
        McpOAuthFailureCode,
        | "mcp_oauth_discovery_failed"
        | "mcp_oauth_address_refused"
        | "mcp_oauth_pkce_unsupported"
        | "mcp_oauth_unreachable"
      >;
    };

const MAX_SCOPES = 50;
const MAX_SCOPE_LENGTH = 1024;
// A scope token (RFC 6749, 3.3): visible ASCII without a double quote and a backslash.
const SCOPE_TOKEN = /^[!#-[\]-~]+$/;

type Challenge = { resourceMetadata: string | null; scope: string | null };

/** The `resource_metadata` and `scope` parameters of a `WWW-Authenticate` challenge. */
export function parseChallenge(header: string | null): Challenge {
  const found: Challenge = { resourceMetadata: null, scope: null };
  if (header === null) return found;
  const parameter = /([A-Za-z_][A-Za-z0-9_-]*)=("((?:[^"\\]|\\.)*)"|[^\s,]+)/g;
  for (const match of header.matchAll(parameter)) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[3] ?? match[2] ?? "";
    if (name === "resource_metadata" && found.resourceMetadata === null)
      found.resourceMetadata = value.replace(/\\(.)/g, "$1");
    if (name === "scope" && found.scope === null)
      found.scope = value.replace(/\\(.)/g, "$1");
  }
  return found;
}

/** The canonical address of a resource: scheme, host and port in lower case, the path without a trailing slash, nothing else (a query
 * string of the server's address, #1122, is not part of it). */
export function canonicalResource(text: string): string | null {
  try {
    const url = new URL(text);
    if (url.hash !== "") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function scopesOf(value: unknown): string[] {
  const list =
    typeof value === "string"
      ? value.split(/\s+/)
      : Array.isArray(value)
        ? (value as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
  const scopes: string[] = [];
  let length = 0;
  for (const scope of list) {
    if (scope === "" || !SCOPE_TOKEN.test(scope) || scopes.includes(scope))
      continue;
    length += scope.length + 1;
    if (scopes.length >= MAX_SCOPES || length > MAX_SCOPE_LENGTH) break;
    scopes.push(scope);
  }
  return scopes;
}

const failureCode = (kind: CallFailure) =>
  kind === "address_refused"
    ? ("mcp_oauth_address_refused" as const)
    : kind === "unreachable"
      ? ("mcp_oauth_unreachable" as const)
      : ("mcp_oauth_discovery_failed" as const);

export async function discoverOAuth(
  target: DiscoveryTarget,
  http: OAuthHttp,
): Promise<DiscoveryResult> {
  const fail = (code: Extract<DiscoveryResult, { ok: false }>["code"]) =>
    ({ ok: false, code }) as const;
  const resource = canonicalResource(target.url);
  if (resource === null || !addressAllowed(target.url, http))
    return fail("mcp_oauth_address_refused");
  const server = new URL(target.url);

  // 1. What the server answers without a credential.
  const probe = await callEndpoint(http, target.url, {
    headersOnly: true,
    ...(target.transport === "sse"
      ? { method: "GET", headers: { accept: "text/event-stream" } }
      : {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "code-reviewer", version: "1" },
            },
          }),
        }),
  });
  if (!probe.ok) return fail(failureCode(probe.kind));
  const challenge =
    probe.status === 401
      ? parseChallenge(probe.headers.get("www-authenticate"))
      : { resourceMetadata: null, scope: null };

  // 2. The protected-resource metadata.
  const path = server.pathname.replace(/\/+$/, "");
  const candidates =
    challenge.resourceMetadata !== null
      ? [challenge.resourceMetadata]
      : [
          ...(path === ""
            ? []
            : [`${server.origin}/.well-known/oauth-protected-resource${path}`]),
          `${server.origin}/.well-known/oauth-protected-resource`,
        ];
  let unreachable = false;
  let metadata: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    const answer = await callEndpoint(http, candidate, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!answer.ok) {
      if (answer.kind === "address_refused")
        return fail("mcp_oauth_address_refused");
      if (answer.kind === "unreachable") unreachable = true;
      continue;
    }
    if (answer.status !== 200 || answer.redirect) continue;
    const document = jsonObject(answer.text);
    if (document === undefined) continue;
    // A document that is about another resource is not this server's.
    if (
      typeof document.resource !== "string" ||
      canonicalResource(document.resource) !== resource
    )
      continue;
    metadata = document;
    break;
  }
  if (metadata === undefined)
    return fail(
      unreachable ? "mcp_oauth_unreachable" : "mcp_oauth_discovery_failed",
    );
  const servers = Array.isArray(metadata.authorization_servers)
    ? (metadata.authorization_servers as unknown[])
    : [];
  const issuerText = servers.find(
    (entry): entry is string => typeof entry === "string",
  );
  if (issuerText === undefined) return fail("mcp_oauth_discovery_failed");

  // 3. The authorization server's metadata.
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuerText);
  } catch {
    return fail("mcp_oauth_discovery_failed");
  }
  if (
    issuerUrl.search !== "" ||
    issuerUrl.hash !== "" ||
    !addressAllowed(issuerUrl.toString(), http)
  )
    return fail("mcp_oauth_address_refused");
  const issuerPath = issuerUrl.pathname.replace(/\/+$/, "");
  const issuer = `${issuerUrl.origin}${issuerPath}`;
  const places =
    issuerPath === ""
      ? [
          `${issuer}/.well-known/oauth-authorization-server`,
          `${issuer}/.well-known/openid-configuration`,
        ]
      : [
          `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
          `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
          `${issuer}/.well-known/openid-configuration`,
        ];
  let server_: Record<string, unknown> | undefined;
  unreachable = false;
  for (const place of places) {
    const answer = await callEndpoint(http, place, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!answer.ok) {
      if (answer.kind === "address_refused")
        return fail("mcp_oauth_address_refused");
      if (answer.kind === "unreachable") unreachable = true;
      continue;
    }
    if (answer.status !== 200 || answer.redirect) continue;
    const document = jsonObject(answer.text);
    if (document === undefined) continue;
    // RFC 8414, 3.3: the issuer in the document is the one it was asked for; otherwise somebody else's document was served here.
    if (
      typeof document.issuer !== "string" ||
      document.issuer.replace(/\/+$/, "") !== issuer
    )
      continue;
    server_ = document;
    break;
  }
  if (server_ === undefined)
    return fail(
      unreachable ? "mcp_oauth_unreachable" : "mcp_oauth_discovery_failed",
    );

  const endpoint = (value: unknown): string | null | "refused" => {
    if (value === undefined) return null;
    if (typeof value !== "string") return "refused";
    return addressAllowed(value, http) ? value : "refused";
  };
  const authorizationEndpoint = endpoint(server_.authorization_endpoint);
  const tokenEndpoint = endpoint(server_.token_endpoint);
  const registrationEndpoint = endpoint(server_.registration_endpoint);
  if (
    authorizationEndpoint === "refused" ||
    tokenEndpoint === "refused" ||
    registrationEndpoint === "refused"
  )
    return fail("mcp_oauth_address_refused");
  if (authorizationEndpoint === null || tokenEndpoint === null)
    return fail("mcp_oauth_discovery_failed");
  const methods = server_.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !(methods as unknown[]).includes("S256"))
    return fail("mcp_oauth_pkce_unsupported");

  const supportedMethods = Array.isArray(
    server_.token_endpoint_auth_methods_supported,
  )
    ? (server_.token_endpoint_auth_methods_supported as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : // RFC 8414, 2: the default when the document does not say.
      ["client_secret_basic"];
  const challengeScopes = scopesOf(challenge.scope);
  return {
    ok: true,
    discovery: {
      resource,
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      scopes:
        challengeScopes.length > 0
          ? challengeScopes
          : scopesOf(metadata.scopes_supported),
      issParameter:
        server_.authorization_response_iss_parameter_supported === true,
      authMethods: supportedMethods,
    },
  };
}
