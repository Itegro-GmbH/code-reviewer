// SPDX-License-Identifier: LicenseRef-Proprietary

// What a started "Connect" keeps in its state (#1051): the server and its revision, what discovery found and the OAuth client the flow uses. The
// callback uses THESE and never the row's discovery or client, so a second flow (a reconnect that was abandoned, two tabs, another discovery
// in between) can neither change what an older flow exchanges nor what a connection that works refreshes with: the row takes discovery and
// client only together with the tokens of the flow that finished (`saveConnection`). Nothing here is a secret: a client secret is in the state
// as the same sealed value the row keeps (AES-256-GCM, bound to the table, the server id and the field).
import {
  MCP_OAUTH_AUTH_METHODS,
  MCP_OAUTH_CLIENT_SOURCES,
  parseMcpOAuthDiscovery,
  type McpOAuthClient,
  type McpOAuthDiscovery,
} from "../../db/repositories/mcp-oauth-repository.ts";

export type McpOAuthFlow = {
  serverId: string;
  revision: number;
  discovery: McpOAuthDiscovery;
  client: McpOAuthClient;
};

/** The JSON the state holds. */
export function flowData(flow: McpOAuthFlow): unknown {
  return {
    serverId: flow.serverId,
    revision: flow.revision,
    discovery: JSON.stringify(flow.discovery),
    client: flow.client,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sealedOrNull(
  value: unknown,
): McpOAuthClient["sealedSecret"] | undefined {
  if (value === null) return null;
  if (
    !isObject(value) ||
    typeof value.ciphertext !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.keyVersion !== "number"
  )
    return undefined;
  return {
    ciphertext: value.ciphertext,
    nonce: value.nonce,
    keyVersion: value.keyVersion,
  };
}

/** The flow a state carries; null when the data is not what `flowData` made. */
export function readFlow(data: unknown): McpOAuthFlow | null {
  if (
    !isObject(data) ||
    typeof data.serverId !== "string" ||
    typeof data.revision !== "number" ||
    typeof data.discovery !== "string" ||
    !isObject(data.client)
  )
    return null;
  const discovery = parseMcpOAuthDiscovery(data.discovery);
  const { client } = data;
  const sealedSecret = sealedOrNull(client.sealedSecret);
  if (
    discovery === null ||
    sealedSecret === undefined ||
    typeof client.clientId !== "string" ||
    !(MCP_OAUTH_CLIENT_SOURCES as readonly unknown[]).includes(client.source) ||
    !(MCP_OAUTH_AUTH_METHODS as readonly unknown[]).includes(client.authMethod)
  )
    return null;
  return {
    serverId: data.serverId,
    revision: data.revision,
    discovery,
    client: {
      source: client.source as McpOAuthClient["source"],
      clientId: client.clientId,
      authMethod: client.authMethod as McpOAuthClient["authMethod"],
      sealedSecret,
      ...(typeof client.registeredIssuer === "string"
        ? { registeredIssuer: client.registeredIssuer }
        : {}),
      ...(typeof client.registeredRedirectUri === "string"
        ? { registeredRedirectUri: client.registeredRedirectUri }
        : {}),
    },
  };
}
