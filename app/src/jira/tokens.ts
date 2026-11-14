// SPDX-License-Identifier: LicenseRef-Proprietary

// The token pair of a connection (#1037): sealed in the row, opened only here, refreshed before it is needed, and handed to the code
// that calls Jira as a `SecretValue` (prints as a placeholder) or not at all (`request` makes the call itself).
//
// Atlassian rotates the refresh token on every refresh. So:
//  - the refresh of a connection is SERIALIZED: the row is locked (`withLockedTokens`, `for update`) from the read of the pair to its
//    write, so a second request that needs a refresh waits, then finds the pair the first one stored and uses it. It never sends a
//    refresh token that the first request already used up. The lock is held across the one call to the token endpoint (10 s at most);
//  - the pair is ONE sealed value, replaced in ONE statement that only succeeds for the version it read (compare and swap);
//  - only `invalid_grant` from the token endpoint (the refresh token is revoked, expired or used) marks the connection `broken` with
//    `jira_refresh_refused`. Anything else that goes wrong (a timeout, a 5xx, the app's own client id or secret rejected, a pair this
//    process cannot decrypt because it has another `APP_SECRET`) changes nothing: `jira_unavailable`, and the operator's log says why.
//    One wrong setting of the operator must not break every connection for good.
// A broken connection makes no call to Atlassian at all.
//
// Nothing here logs a token or puts one in a result; the logs hold a code and the connection id.
import "server-only";
import { decryptSecret, encryptSecret } from "../crypto/secret-box.ts";
import type {
  JiraConnectionsRepository,
  SealedTokens,
  StoredJiraConnection,
  StoredJiraTokens,
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
  function ended(connection: StoredJiraConnection): boolean {
    return (
      Date.parse(connection.accessExpiresAt) - now().getTime() <=
      REFRESH_MARGIN_MS
    );
  }

  type Checked =
    | { kind: "done"; result: Current }
    | {
        kind: "renew";
        connection: StoredJiraConnection;
        pair: Pair;
        tokenVersion: number;
      };
  type Current =
    | { ok: true; connection: StoredJiraConnection; pair: Pair }
    | Extract<UseTokenResult, { ok: false }>;

  /** What a read of the row says: a failure, a pair that is good, or a pair that has to be renewed (`force`: the caller was told its token is no good). */
  function check(
    read: StoredJiraTokens | undefined,
    force: boolean,
    rejected: string | null,
  ): Checked {
    if (read === undefined)
      return {
        kind: "done",
        result: { ok: false, error: "jira_connection_not_found" },
      };
    const { connection, sealed, tokenVersion } = read;
    if (connection.status === "broken")
      return {
        kind: "done",
        result: {
          ok: false,
          error: "jira_connection_broken",
          ...(connection.errorCode === null
            ? {}
            : { brokenCode: connection.errorCode }),
        },
      };
    const pair = openPair(appSecret, connection.id, sealed);
    if (pair === null) {
      // This process cannot read the pair: most likely it has another APP_SECRET than the one that sealed it. The row is fine for the
      // process that has the right key, so it is not marked broken.
      log(
        `[jira] JIRA_TOKENS_UNREADABLE: check APP_SECRET (connection ${connection.id})`,
      );
      return {
        kind: "done",
        result: { ok: false, error: "jira_unavailable" },
      };
    }
    // A caller that was told its token is no good gets a new one, unless another request replaced the pair since.
    const mustRenew =
      ended(connection) || (force && pair.accessToken === rejected);
    return mustRenew
      ? { kind: "renew", connection, pair, tokenVersion }
      : { kind: "done", result: { ok: true, connection, pair } };
  }

  /** The connection and its opened pair, or the failure; `force` renews the token even though it still looks good. */
  async function current(
    connectionId: string,
    force: boolean,
    rejected: string | null,
  ): Promise<Current> {
    const first = check(
      await repository.readTokens(connectionId),
      force,
      rejected,
    );
    if (first.kind === "done") return first.result;
    // A renewal: one at a time per connection. Whoever gets the lock reads the row again; a request that waited finds the pair of the
    // one before it and has nothing left to renew.
    return repository.withLockedTokens(connectionId, async (locked, writes) => {
      const checked = check(locked, force, rejected);
      if (checked.kind === "done") return checked.result;
      const { connection, pair, tokenVersion } = checked;
      const grant = await client.refresh(pair.refreshToken);
      if (!grant.ok) {
        if (grant.kind === "unavailable")
          return { ok: false, error: "jira_unavailable" } as const;
        // Refused: the pair the row holds NOW is the one that was sent (the row is locked), so it really is dead.
        if (await writes.markBroken(tokenVersion, "jira_refresh_refused"))
          log(
            `[jira] JIRA_CONNECTION_BROKEN: jira_refresh_refused (connection ${connection.id})`,
          );
        return {
          ok: false,
          error: "jira_connection_broken",
          brokenCode: "jira_refresh_refused",
        } as const;
      }
      // Atlassian answers with the rotated refresh token; an answer without one keeps the one that was sent.
      const renewed: Pair = {
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken ?? pair.refreshToken,
      };
      const expiresAt = new Date(
        now().getTime() + grant.expiresInSeconds * 1000,
      );
      const stored = await writes.replaceTokens(
        tokenVersion,
        sealPair(appSecret, connection.id, renewed),
        expiresAt,
      );
      // The row is locked since the read, so the version cannot have moved; if it did anyway the pair is lost and the call can be repeated.
      if (!stored) return { ok: false, error: "jira_unavailable" } as const;
      return {
        ok: true,
        connection: { ...connection, accessExpiresAt: expiresAt.toISOString() },
        pair: renewed,
      } as const;
    });
  }

  async function acquire(
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
    use: (connectionId) => acquire(connectionId),

    async request(connectionId, path, init) {
      if (!path.startsWith("/"))
        throw new Error("A Jira path starts with a slash.");
      let result = await acquire(connectionId);
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
        // The answer is not used: let go of the connection it holds before the call is repeated.
        await response.body?.cancel().catch(() => undefined);
        result = await acquire(connectionId, true, result.accessToken.reveal());
      }
      return { ok: false, error: "jira_unavailable" };
    },
  };
}
