// SPDX-License-Identifier: LicenseRef-Proprietary

// The token pair and the client secret of an OAuth connection of an MCP server (#1051): sealed in the connection's row, opened only here, the
// access token renewed BEFORE it is needed, and handed to the code that calls the MCP server as a `SecretValue` (prints as a placeholder).
// The same rules as the Jira connection (src/jira/tokens.ts, #1037):
//  - the refresh of a server is SERIALIZED: the row is locked (`withLockedTokens`) from the read of the pair to its write, so a second request
//    that needs a refresh waits, then finds the pair the first one stored and never sends a refresh token that the first one already used up
//    (refresh tokens may rotate). The lock is held across the one call to the token endpoint (its own deadline);
//  - the pair is ONE sealed value, replaced in ONE statement that only succeeds for the version it read (compare and swap);
//  - only `invalid_grant` from the token endpoint (the refresh token is revoked, expired or used) marks the connection `broken`
//    (`mcp_oauth_refresh_refused`), as does an access token that ended when the grant has no refresh token (`mcp_oauth_expired`). Anything else
//    that goes wrong (a timeout, a 5xx, the client's id or secret rejected, an address that is no longer allowed, a pair this process cannot
//    open because it has another `APP_SECRET`) changes nothing: `mcp_oauth_unavailable`, and the operator's log says why. One wrong setting
//    must not break a connection for good.
// A broken connection, and a connection that was made for another address than the server has now, make no call at all. The tokens were issued
// for ONE resource: they are never sent anywhere else.
// Nothing here logs a token or a secret; the logs hold a code and the server id.
import "server-only";
import { decryptSecret, encryptSecret } from "../../crypto/secret-box.ts";
import type {
  McpOAuthRepository,
  McpOAuthSecrets,
  SealedBlob,
} from "../../db/repositories/mcp-oauth-repository.ts";
import { SecretValue } from "../../secrets/secret-value.ts";
import { canonicalResource } from "./discovery.ts";
import type { OAuthHttp } from "./endpoint-http.ts";
import type { McpOAuthBrokenCode, McpOAuthUseCode } from "./errors.ts";
import { refreshGrant, type OAuthClientAuth } from "./token-endpoint.ts";

/** The access token is renewed when it ends within this long: a call never starts with a token about to run out. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const TABLE = "mcp_oauth_connections";
const TOKENS = "tokens";
const CLIENT = "client";

type Pair = { accessToken: string; refreshToken: string | null };

const blob = (sealed: {
  ciphertext: string;
  nonce: string;
  keyVersion: number;
}): SealedBlob => ({
  ciphertext: sealed.ciphertext,
  nonce: sealed.nonce,
  keyVersion: sealed.keyVersion,
});

/** Seals a pair for the row of a server: the table, the server id and the field are bound into the ciphertext. */
export function sealOAuthTokens(
  appSecret: string,
  serverId: string,
  pair: Pair,
): SealedBlob {
  return blob(
    encryptSecret(
      appSecret,
      { table: TABLE, rowId: serverId, field: TOKENS },
      JSON.stringify(pair),
    ),
  );
}

/** Seals the client secret entered by an Owner or Admin, or returned by a registration, for the row of a server. */
export function sealOAuthClientSecret(
  appSecret: string,
  serverId: string,
  secret: string,
): SealedBlob {
  return blob(
    encryptSecret(
      appSecret,
      { table: TABLE, rowId: serverId, field: CLIENT },
      secret,
    ),
  );
}

export function openOAuthClientSecret(
  appSecret: string,
  serverId: string,
  sealed: SealedBlob,
): string | null {
  try {
    return decryptSecret(
      appSecret,
      { table: TABLE, rowId: serverId, field: CLIENT },
      sealed,
    );
  } catch {
    return null;
  }
}

function openPair(
  appSecret: string,
  serverId: string,
  sealed: SealedBlob,
): Pair | null {
  try {
    const value: unknown = JSON.parse(
      decryptSecret(
        appSecret,
        { table: TABLE, rowId: serverId, field: TOKENS },
        sealed,
      ),
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "accessToken" in value &&
      typeof value.accessToken === "string" &&
      "refreshToken" in value &&
      (value.refreshToken === null || typeof value.refreshToken === "string")
    )
      return {
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
      };
    return null;
  } catch {
    return null;
  }
}

export type UseOAuthTokenResult =
  | { ok: true; accessToken: SecretValue }
  | {
      ok: false;
      error: McpOAuthUseCode;
      /** Why a broken connection is broken. */
      brokenCode?: McpOAuthBrokenCode;
    };

export type McpOAuthTokens = {
  /**
   * A fresh access token of the server, renewing it first when it ends soon. `serverUrl` is the address the server has NOW: a connection made
   * for another address gives nothing. `rejected` is the token a caller was told is no good (a 401): it is renewed even though it still looks
   * good, unless another request has replaced it since.
   */
  use(
    serverId: string,
    options: { serverUrl: string; rejected?: string },
  ): Promise<UseOAuthTokenResult>;
};

export type McpOAuthTokensOptions = {
  repository: McpOAuthRepository;
  appSecret: string;
  http: OAuthHttp;
  now?: () => Date;
  log?: (line: string) => void;
};

export function createMcpOAuthTokens({
  repository,
  appSecret,
  http,
  now = () => new Date(),
  log = (line) => console.error(line),
}: McpOAuthTokensOptions): McpOAuthTokens {
  type Current =
    { ok: true; pair: Pair } | Extract<UseOAuthTokenResult, { ok: false }>;
  type Checked =
    | { kind: "done"; result: Current }
    | { kind: "renew"; secrets: McpOAuthSecrets; pair: Pair };

  function check(
    read: McpOAuthSecrets | undefined,
    serverId: string,
    serverUrl: string,
    rejected: string | null,
  ): Checked {
    const done = (result: Current): Checked => ({ kind: "done", result });
    if (read === undefined)
      return done({ ok: false, error: "mcp_oauth_not_connected" });
    const { oauth } = read;
    if (oauth.status === "broken")
      return done({
        ok: false,
        error: "mcp_oauth_broken",
        ...(oauth.errorCode === null
          ? {}
          : { brokenCode: oauth.errorCode as McpOAuthBrokenCode }),
      });
    if (oauth.status !== "connected" || read.tokens === null)
      return done({ ok: false, error: "mcp_oauth_not_connected" });
    if (
      oauth.discovery === null ||
      oauth.discovery.resource !== canonicalResource(serverUrl)
    ) {
      // The tokens belong to another address: the registry drops them with the edit, so this is a row that should not be there.
      log(`[mcp] MCP_OAUTH_RESOURCE_MISMATCH: server ${serverId}.`);
      return done({ ok: false, error: "mcp_oauth_not_connected" });
    }
    const pair = openPair(appSecret, serverId, read.tokens);
    if (pair === null) {
      // This process cannot read the pair: most likely it has another APP_SECRET than the one that sealed it. The row is fine for the process
      // that has the right key, so it is not marked broken.
      log(
        `[mcp] MCP_OAUTH_TOKENS_UNREADABLE: check APP_SECRET (server ${serverId}).`,
      );
      return done({ ok: false, error: "mcp_oauth_unavailable" });
    }
    const ends = Date.parse(oauth.accessExpiresAt ?? "") - now().getTime();
    const mustRenew =
      !(ends > REFRESH_MARGIN_MS) ||
      (rejected !== null && pair.accessToken === rejected);
    return mustRenew
      ? { kind: "renew", secrets: read, pair }
      : done({ ok: true, pair });
  }

  async function renew(
    serverId: string,
    serverUrl: string,
    rejected: string | null,
  ): Promise<Current> {
    return repository.withLockedTokens(serverId, async (locked, writes) => {
      // Whoever gets the lock reads the row again: a request that waited finds the pair of the one before it and has nothing left to renew.
      const checked = check(locked, serverId, serverUrl, rejected);
      if (checked.kind === "done") return checked.result;
      const { secrets, pair } = checked;
      const discovery = secrets.oauth.discovery;
      if (discovery === null)
        return { ok: false, error: "mcp_oauth_not_connected" } as const;
      const broken = async (code: McpOAuthBrokenCode): Promise<Current> => {
        if (await writes.markBroken(secrets.tokenVersion, code))
          log(
            `[mcp] MCP_OAUTH_CONNECTION_BROKEN: ${code} (server ${serverId}).`,
          );
        return { ok: false, error: "mcp_oauth_broken", brokenCode: code };
      };
      if (pair.refreshToken === null) return broken("mcp_oauth_expired");
      const clientId = secrets.oauth.clientId;
      const method = secrets.oauth.clientAuthMethod;
      if (clientId === null || method === null)
        return { ok: false, error: "mcp_oauth_not_connected" } as const;
      let clientSecret: string | null = null;
      if (secrets.clientSecret !== null) {
        clientSecret = openOAuthClientSecret(
          appSecret,
          serverId,
          secrets.clientSecret,
        );
        if (clientSecret === null) {
          log(
            `[mcp] MCP_OAUTH_CLIENT_UNREADABLE: check APP_SECRET (server ${serverId}).`,
          );
          return { ok: false, error: "mcp_oauth_unavailable" } as const;
        }
      }
      const client: OAuthClientAuth = { clientId, clientSecret, method };
      const result = await refreshGrant(
        discovery,
        client,
        pair.refreshToken,
        http,
      );
      if (!result.ok) {
        // Only the grant's own end marks the connection: the pair the row holds NOW is the one that was sent (the row is locked), so it
        // really is dead. A client the server does not accept is the operator's to mend, and says so in the log.
        if (result.kind === "refused")
          return broken("mcp_oauth_refresh_refused");
        log(
          `[mcp] MCP_OAUTH_REFRESH_FAILED: ${result.kind === "client" ? "the authorization server does not accept the OAuth client (check the client id and secret)" : result.kind} (server ${serverId}).`,
        );
        return { ok: false, error: "mcp_oauth_unavailable" } as const;
      }
      // A refresh token may rotate; an answer without one keeps the one that was sent.
      const renewed: Pair = {
        accessToken: result.grant.accessToken,
        refreshToken: result.grant.refreshToken ?? pair.refreshToken,
      };
      const stored = await writes.replaceTokens(
        secrets.tokenVersion,
        sealOAuthTokens(appSecret, serverId, renewed),
        new Date(now().getTime() + result.grant.expiresInSeconds * 1000),
        result.grant.scopes,
      );
      // The row is locked since the read, so the version cannot have moved; if it did anyway the pair is lost and the call can be repeated.
      if (!stored)
        return { ok: false, error: "mcp_oauth_unavailable" } as const;
      return { ok: true, pair: renewed } as const;
    });
  }

  return {
    async use(serverId, { serverUrl, rejected }) {
      const first = check(
        await repository.readSecrets(serverId),
        serverId,
        serverUrl,
        rejected ?? null,
      );
      const result =
        first.kind === "done"
          ? first.result
          : await renew(serverId, serverUrl, rejected ?? null);
      return result.ok
        ? { ok: true, accessToken: new SecretValue(result.pair.accessToken) }
        : result;
    },
  };
}
