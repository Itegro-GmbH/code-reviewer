// SPDX-License-Identifier: LicenseRef-Proprietary

// The token pair of a connection (#1037): sealed in the row, opened only here, refreshed before it is needed, and handed to the code
// that calls Jira as a `SecretValue` (prints as a placeholder) or not at all (`request` makes the call itself).
//
// Atlassian rotates the refresh token on every refresh. So:
//  - the pair is ONE sealed value, replaced in ONE statement that only succeeds for the version it read (compare and swap,
//    `replaceTokens`): two requests that refresh at once cannot overwrite each other's pair;
//  - a refresh that Atlassian refused is not yet a broken connection: when the pair changed in the meantime (the other request won and
//    used up the token this one sent) the connection is fine and the newer pair is used. Only a refusal for the pair that is still the
//    current one marks the connection `broken` with `jira_refresh_refused`;
//  - a refresh that could not be made (a timeout, a 5xx) changes nothing: `jira_unavailable`, try again.
// A pair that cannot be decrypted (another `APP_SECRET`) is `broken` with `jira_tokens_unreadable`. A broken connection makes no call to
// Atlassian at all.
//
// Nothing here logs a token or puts one in a result; the logs hold a code and the connection id.
import { decryptSecret, encryptSecret } from "../crypto/secret-box.ts";
import type {
  JiraConnectionsRepository,
  SealedTokens,
  StoredJiraConnection,
} from "../db/repositories/jira-connections-repository.ts";
import { SecretValue } from "../secrets/secret-value.ts";
import type { AtlassianClient } from "./client.ts";
import type { JiraBrokenCode, JiraCallErrorCode } from "./errors.ts";

/** The access token is renewed when it ends within this long: a call never starts with a token about to run out. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

type Pair = { accessToken: string; refreshToken: string };

const TABLE = "jira_connections";
const FIELD = "tokens";

/** Seals a pair for a row: the table, the row id and the field are bound into the ciphertext. */
export function sealPair(
  appSecret: string,
  connectionId: string,
  pair: Pair,
): SealedTokens {
  const sealed = encryptSecret(
    appSecret,
    { table: TABLE, rowId: connectionId, field: FIELD },
    JSON.stringify(pair),
  );
  return {
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    keyVersion: sealed.keyVersion,
  };
}

function openPair(
  appSecret: string,
  connectionId: string,
  sealed: SealedTokens,
): Pair | null {
  try {
    const value: unknown = JSON.parse(
      decryptSecret(
        appSecret,
        { table: TABLE, rowId: connectionId, field: FIELD },
        sealed,
      ),
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "accessToken" in value &&
      typeof value.accessToken === "string" &&
      "refreshToken" in value &&
      typeof value.refreshToken === "string"
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

export type UseTokenResult =
  | {
      ok: true;
      accessToken: SecretValue;
      connection: StoredJiraConnection;
    }
  | {
      ok: false;
      error: JiraCallErrorCode;
      /** Why a broken connection is broken. */
      brokenCode?: JiraBrokenCode | string;
    };

export type JiraRequestResult =
  { ok: true; response: Response } | Extract<UseTokenResult, { ok: false }>;

export type JiraTokens = {
  /** A fresh access token of the connection, refreshing first when it ends soon. */
  use(connectionId: string): Promise<UseTokenResult>;
  /**
   * A request to the Jira API of the connection's site (`path` starts with `/`, for example `/rest/api/3/myself`). The token is
   * renewed before the call when it ends soon; an answer 401 (Atlassian ended it early) renews it and repeats the call once.
   */
  request(
    connectionId: string,
    path: string,
    init?: RequestInit,
  ): Promise<JiraRequestResult>;
};

export type JiraTokensOptions = {
  repository: JiraConnectionsRepository;
  client: AtlassianClient;
  appSecret: string;
  now?: () => Date;
  log?: (line: string) => void;
};

export function createJiraTokens({
  repository,
  client,
  appSecret,
  now = () => new Date(),
  log = (line) => console.error(line),
}: JiraTokensOptions): JiraTokens {
  async function breakConnection(
    connection: StoredJiraConnection,
    version: number,
    code: JiraBrokenCode,
  ): Promise<void> {
    if (await repository.markBroken(connection.id, version, code))
      log(
        `[jira] JIRA_CONNECTION_BROKEN: ${code} (connection ${connection.id})`,
      );
  }

  function ended(connection: StoredJiraConnection): boolean {
    return (
      Date.parse(connection.accessExpiresAt) - now().getTime() <=
      REFRESH_MARGIN_MS
    );
  }

  /** The connection and its opened pair, or the failure; `force` renews the token even though it still looks good. */
  async function current(
    connectionId: string,
    force: boolean,
    rejected: string | null,
  ): Promise<
    | { ok: true; connection: StoredJiraConnection; pair: Pair }
    | Extract<UseTokenResult, { ok: false }>
  > {
    const read = await repository.readTokens(connectionId);
    if (read === undefined)
      return { ok: false, error: "jira_connection_not_found" };
    const { connection, sealed, tokenVersion } = read;
    if (connection.status === "broken")
      return {
        ok: false,
        error: "jira_connection_broken",
        ...(connection.errorCode === null
          ? {}
          : { brokenCode: connection.errorCode }),
      };
    const pair = openPair(appSecret, connection.id, sealed);
    if (pair === null) {
      await breakConnection(connection, tokenVersion, "jira_tokens_unreadable");
      return {
        ok: false,
        error: "jira_connection_broken",
        brokenCode: "jira_tokens_unreadable",
      };
    }
    // A caller that was told its token is no good gets a new one, unless another request replaced the pair since.
    const mustRenew =
      ended(connection) || (force && pair.accessToken === rejected);
    if (!mustRenew) return { ok: true, connection, pair };

    const grant = await client.refresh(pair.refreshToken);
    if (grant.ok) {
      // Atlassian answers with the rotated refresh token; an answer without one keeps the one that was sent.
      const renewed: Pair = {
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken ?? pair.refreshToken,
      };
      const expiresAt = new Date(
        now().getTime() + grant.expiresInSeconds * 1000,
      );
      if (
        await repository.replaceTokens(
          connection.id,
          tokenVersion,
          sealPair(appSecret, connection.id, renewed),
          expiresAt,
        )
      )
        return {
          ok: true,
          connection: {
            ...connection,
            accessExpiresAt: expiresAt.toISOString(),
          },
          pair: renewed,
        };
      // Another request refreshed first and stored its pair: use that one (ours is dropped; its refresh token was rotated away).
      return current(connectionId, false, null);
    }
    if (grant.kind === "unavailable")
      return { ok: false, error: "jira_unavailable" };
    // Refused. If the pair is no longer the one this request sent, a concurrent refresh used the token up and the connection is fine.
    const again = await repository.readTokens(connectionId);
    if (again !== undefined && again.tokenVersion !== tokenVersion)
      return current(connectionId, false, null);
    await breakConnection(connection, tokenVersion, "jira_refresh_refused");
    return {
      ok: false,
      error: "jira_connection_broken",
      brokenCode: "jira_refresh_refused",
    };
  }

  async function use(
    connectionId: string,
    force = false,
    rejected: string | null = null,
  ): Promise<UseTokenResult> {
    const result = await current(connectionId, force, rejected);
    if (!result.ok) return result;
    return {
      ok: true,
      accessToken: new SecretValue(result.pair.accessToken),
      connection: result.connection,
    };
  }

  return {
    use: (connectionId) => use(connectionId),

    async request(connectionId, path, init) {
      if (!path.startsWith("/"))
        throw new Error("A Jira path starts with a slash.");
      let result = await use(connectionId);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!result.ok) return result;
        const response = await client.send(
          `${client.jiraBase(result.connection.cloudId)}${path}`,
          result.accessToken.reveal(),
          init,
        );
        if (response === null) return { ok: false, error: "jira_unavailable" };
        if (response.status !== 401 || attempt === 1)
          return { ok: true, response };
        result = await use(connectionId, true, result.accessToken.reveal());
      }
      return { ok: false, error: "jira_unavailable" };
    },
  };
}
