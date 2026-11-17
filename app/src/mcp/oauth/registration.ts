// SPDX-License-Identifier: LicenseRef-Proprietary

// Dynamic client registration (RFC 7591): this server registers itself as a public client (PKCE, no secret) at the authorization server's
// registration endpoint, for the callback address of the factory. When the authorization server answers with a secret anyway, it is kept and
// used the way the answer says. Where there is no registration endpoint, an Owner or Admin enters a client id (and secret) by hand: the code
// says so (`mcp_oauth_client_required`). The endpoint is guarded like every address of the flow (`endpoint-http.ts`).
import type {
  McpOAuthAuthMethod,
  McpOAuthDiscovery,
} from "../../db/repositories/mcp-oauth-repository.ts";
import { callEndpoint, jsonObject, type OAuthHttp } from "./endpoint-http.ts";
import type { McpOAuthFailureCode } from "./errors.ts";

const CLIENT_ID_MAX_LENGTH = 512;
const SECRET_MAX_LENGTH = 4096;
const VISIBLE = /^[ -~]+$/;

export type RegisteredClient = {
  clientId: string;
  clientSecret: string | null;
  authMethod: McpOAuthAuthMethod;
};

export type RegistrationResult =
  | { ok: true; client: RegisteredClient }
  | {
      ok: false;
      code: Extract<
        McpOAuthFailureCode,
        | "mcp_oauth_client_required"
        | "mcp_oauth_registration_failed"
        | "mcp_oauth_address_refused"
        | "mcp_oauth_unreachable"
      >;
    };

export async function registerClient(
  discovery: McpOAuthDiscovery,
  flow: { redirectUri: string; clientName: string },
  http: OAuthHttp,
): Promise<RegistrationResult> {
  if (discovery.registrationEndpoint === null)
    return { ok: false, code: "mcp_oauth_client_required" };
  const answer = await callEndpoint(http, discovery.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: flow.clientName,
      redirect_uris: [flow.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(discovery.scopes.length === 0
        ? {}
        : { scope: discovery.scopes.join(" ") }),
    }),
  });
  if (!answer.ok) {
    if (answer.kind === "address_refused")
      return { ok: false, code: "mcp_oauth_address_refused" };
    if (answer.kind === "unreachable")
      return { ok: false, code: "mcp_oauth_unreachable" };
    return { ok: false, code: "mcp_oauth_registration_failed" };
  }
  const refused = { ok: false, code: "mcp_oauth_registration_failed" } as const;
  if (answer.redirect || (answer.status !== 200 && answer.status !== 201))
    return refused;
  const document = jsonObject(answer.text);
  if (document === undefined) return refused;
  const { client_id: clientId, client_secret: secret } = document;
  if (
    typeof clientId !== "string" ||
    clientId === "" ||
    clientId.length > CLIENT_ID_MAX_LENGTH ||
    !VISIBLE.test(clientId)
  )
    return refused;
  // A registration that does not hold the callback address would send the code somewhere else (or nowhere).
  if (
    Array.isArray(document.redirect_uris) &&
    !(document.redirect_uris as unknown[]).includes(flow.redirectUri)
  )
    return refused;
  if (secret === undefined || secret === null || secret === "")
    return {
      ok: true,
      client: { clientId, clientSecret: null, authMethod: "none" },
    };
  if (
    typeof secret !== "string" ||
    secret.length > SECRET_MAX_LENGTH ||
    !VISIBLE.test(secret)
  )
    return refused;
  return {
    ok: true,
    client: {
      clientId,
      clientSecret: secret,
      authMethod:
        document.token_endpoint_auth_method === "client_secret_post"
          ? "client_secret_post"
          : "client_secret_basic",
    },
  };
}
