// SPDX-License-Identifier: LicenseRef-Proprietary

// The two discovery documents the MCP authorization specification asks for, as pure functions of the app's address.
// RFC 9728 (protected resource metadata): tells a client that has just got a 401 from `/api/mcp` which authorization server to use.
// RFC 8414 (authorization server metadata): where to register, authorize and get tokens, and what is supported: the authorization code
// flow with PKCE S256 only, public clients only, dynamic client registration, revocation, and the `iss` response parameter (RFC 9207).
import { FACTORY_SCOPES } from "../scopes.ts";
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  MCP_ENDPOINT_PATH,
  OAUTH_PATHS,
  PROTECTED_RESOURCE_METADATA_PATH,
} from "./paths.ts";

export function resourceOf(baseUrl: string): string {
  return `${baseUrl}${MCP_ENDPOINT_PATH}`;
}

/** The address of the metadata of the protected resource (the one a 401 names), with the resource path appended as RFC 9728 section 3.1 says. */
export function resourceMetadataUrl(baseUrl: string): string {
  return `${baseUrl}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_ENDPOINT_PATH}`;
}

export function protectedResourceMetadata(baseUrl: string) {
  return {
    resource: resourceOf(baseUrl),
    authorization_servers: [baseUrl],
    scopes_supported: [...FACTORY_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Factory MCP",
  };
}

export function authorizationServerMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${baseUrl}${OAUTH_PATHS.token}`,
    registration_endpoint: `${baseUrl}${OAUTH_PATHS.register}`,
    revocation_endpoint: `${baseUrl}${OAUTH_PATHS.revoke}`,
    scopes_supported: [...FACTORY_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    // The audience of every token is the endpoint itself (RFC 8707); `resource` is accepted and checked, not required.
    resource_indicators_supported: true,
  };
}

export { AUTHORIZATION_SERVER_METADATA_PATH };
