// SPDX-License-Identifier: LicenseRef-Proprietary

// What the proxy puts on a request to an MCP server (#1053, epic #1049): the credential of the server, as request headers. This is the ONE
// place that turns what is stored into a credential for a call, so a new kind of authentication is one provider here and nothing in the
// proxy changes.
//
// The credential never leaves the app: the proxy (`proxy.ts`) calls this inside the request it forwards, the headers live in that request
// and nowhere else (not in a return value that is logged, not in the job document, not in a file of the sandbox). A provider answers with
// a stable code on failure, never with a value or a text of the stored data.
//
// Kinds:
// - `none`: no header.
// - `header` (#1050): the sealed headers of the row, opened with the master key.
// - `oauth` (#1051, in progress): the access token of the server, refreshed when it is about to run out. TODO(#1051): register the provider
//   with `createMcpCredentials({ providers: { oauth } })`: it receives the server (and its id, so it can read its own table) and returns
//   `Authorization: Bearer <fresh token>`, or `mcp_credential_broken` when the connection needs a new sign-in. The proxy needs no other
//   change; until then a server of that kind is `mcp_credential_unsupported` (the registry does not offer the kind either).
import type {
  SealedHeaders,
  StoredMcpServer,
} from "../db/repositories/mcp-servers-repository.ts";
import { openHeaders } from "./service.ts";

export const MCP_CREDENTIAL_FAILURES = [
  /** The server needs a kind of credential this deployment has no provider for. */
  "mcp_credential_unsupported",
  /** The stored credential cannot be used: it cannot be opened (a master key that changed), or the connection needs a new sign-in. */
  "mcp_credential_broken",
] as const;
export type McpCredentialFailure = (typeof MCP_CREDENTIAL_FAILURES)[number];

export type McpCredentialResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; code: McpCredentialFailure };

/** A server with the sealed headers of its row (null for a server without any), as `readHeaders` of the repository reads it. */
export type McpServerWithSecrets = {
  server: StoredMcpServer;
  sealed: SealedHeaders | null;
};

export type McpCredentialProvider = {
  headersFor(stored: McpServerWithSecrets): Promise<McpCredentialResult>;
};

export type McpCredentials = {
  headersFor(stored: McpServerWithSecrets): Promise<McpCredentialResult>;
};

const NO_CREDENTIAL: McpCredentialProvider = {
  headersFor: () => Promise.resolve({ ok: true, headers: {} }),
};

/** The provider of kind `header`: the sealed headers of the row, opened with the master key. */
export function headerCredentialProvider(
  appSecret: string,
): McpCredentialProvider {
  return {
    headersFor({ server, sealed }) {
      if (sealed === null)
        return Promise.resolve({ ok: false, code: "mcp_credential_broken" });
      const opened = openHeaders(appSecret, server.id, sealed);
      if (opened === null)
        return Promise.resolve({ ok: false, code: "mcp_credential_broken" });
      const headers: Record<string, string> = {};
      for (const { name, value } of opened) headers[name] = value;
      return Promise.resolve({ ok: true, headers });
    },
  };
}

/** The credentials of a deployment: one provider for each kind of authentication; a kind without a provider is refused, never sent without. */
export function createMcpCredentials(options: {
  appSecret: string;
  /** More providers by kind (`oauth`, #1051), or another one for a kind (tests). */
  providers?: Readonly<Record<string, McpCredentialProvider>>;
}): McpCredentials {
  const providers: Record<string, McpCredentialProvider> = {
    none: NO_CREDENTIAL,
    header: headerCredentialProvider(options.appSecret),
    ...options.providers,
  };
  return {
    headersFor(stored) {
      const provider = providers[stored.server.authKind];
      if (provider === undefined)
        return Promise.resolve({
          ok: false,
          code: "mcp_credential_unsupported",
        });
      return provider.headersFor(stored);
    },
  };
}
