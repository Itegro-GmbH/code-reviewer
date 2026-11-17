// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the OAuth connections of the MCP servers of ONE workspace (#1051, epic #1049; the table `mcp_oauth_connections`; the factory takes
// the workspace id, see ../workspace-scope.ts). The module only moves rows: the sealing, the discovery, the refresh and the rules of the flow
// are in src/mcp/oauth/. A sealed value is never part of a `StoredMcpOAuth` (what the pages and the API read); only `readSecrets` and
// `withLockedTokens` hand it out, to the code that opens it.
//
// A token write is a compare and swap on `token_version` (`replaceTokens`, `markBroken`): a refresh token may rotate on every refresh, so of two
// requests that refresh at once only the first may store its pair. `withLockedTokens` goes further for the refresh itself: it holds the row
// lock (`for no key update`) from the read to the write, so a second refresh of the same server waits for the first and then reads the pair the
// first stored, instead of sending a refresh token that is already used up.
//
// A connection is saved for the REVISION of the server it was started for (`saveConnection`): the callback of a flow that was started before the
// address was changed does not store tokens for the new address (the server row is locked `for share`, which an edit's `for no key update` waits
// for). `dropFor` and `replaceManualClient` are what the registry's own update calls in ITS transaction (mcp-servers-repository.ts).
//
// What discovery found and the OAuth client of a flow are written ONLY together with the tokens that flow produced (`saveConnection`, one
// statement): the row's discovery and client always describe the grant its tokens are, so a "Reconnect" that is abandoned, or that finds another
// authorization server, changes nothing about a connection that works. A started flow keeps its own discovery and client in its state.
import "server-only";
import { type Kysely, type Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, McpOauthConnectionsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export const MCP_OAUTH_STATUSES = [
  "unconnected",
  "connected",
  "broken",
] as const;
export type McpOAuthStatus = (typeof MCP_OAUTH_STATUSES)[number];

export const MCP_OAUTH_CLIENT_SOURCES = ["manual", "dynamic"] as const;
export type McpOAuthClientSource = (typeof MCP_OAUTH_CLIENT_SOURCES)[number];

export const MCP_OAUTH_AUTH_METHODS = [
  "none",
  "client_secret_basic",
  "client_secret_post",
] as const;
export type McpOAuthAuthMethod = (typeof MCP_OAUTH_AUTH_METHODS)[number];

/** A value as the database holds it: sealed (src/crypto/secret-box.ts). */
export type SealedBlob = {
  ciphertext: string;
  nonce: string;
  keyVersion: number;
};

/** What discovery found for a server (RFC 9728, RFC 8414): nothing in it is secret. */
export type McpOAuthDiscovery = {
  /** The canonical address of the MCP server: the `resource` parameter of every request. */
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  /** The scopes to ask for (may be empty). */
  scopes: string[];
  /** RFC 9207: the authorization server puts `iss` in the redirect and says so. */
  issParameter: boolean;
  /** The `token_endpoint_auth_methods_supported` of the authorization server. */
  authMethods: string[];
};

/** A connection as the pages and the API may know it: everything but the sealed values. */
export type StoredMcpOAuth = {
  serverId: string;
  workspaceId: string;
  status: McpOAuthStatus;
  /** Why the connection is broken (a code of `src/mcp/oauth/errors.ts`); null unless it is. */
  errorCode: string | null;
  discovery: McpOAuthDiscovery | null;
  clientSource: McpOAuthClientSource | null;
  clientId: string | null;
  clientAuthMethod: McpOAuthAuthMethod | null;
  hasClientSecret: boolean;
  registeredIssuer: string | null;
  registeredRedirectUri: string | null;
  /** When the access token ends; null while there is none. */
  accessExpiresAt: string | null;
  /** The scopes the authorization server granted. */
  scopes: string[];
  connectedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** What a connection's row holds for the code that opens the sealed values. */
export type McpOAuthSecrets = {
  oauth: StoredMcpOAuth;
  clientSecret: SealedBlob | null;
  tokens: SealedBlob | null;
  tokenVersion: number;
};

export type McpOAuthClient = {
  source: McpOAuthClientSource;
  clientId: string;
  authMethod: McpOAuthAuthMethod;
  sealedSecret: SealedBlob | null;
  /** For a dynamic client: what it was registered for. */
  registeredIssuer?: string;
  registeredRedirectUri?: string;
};

/** What the registry's update does to the connection in the transaction that changes the server. */
export type McpOAuthChange =
  { kind: "drop" } | { kind: "replace-manual"; client: McpOAuthClient };

export type SaveMcpOAuthConnection = {
  /** What discovery found when the flow started: the grant is for these endpoints. */
  discovery: McpOAuthDiscovery;
  /** The OAuth client the flow used: the grant is for this client. */
  client: McpOAuthClient;
  sealedTokens: SealedBlob;
  accessExpiresAt: Date;
  scopes: string[];
  connectedBy: string | null;
};

/** The token writes of the row a `withLockedTokens` call holds; each one is a compare and swap on the version. */
export type LockedMcpOAuthWrites = {
  replaceTokens(
    expectedVersion: number,
    sealed: SealedBlob,
    accessExpiresAt: Date,
    scopes: string[] | null,
  ): Promise<boolean>;
  markBroken(expectedVersion: number, errorCode: string): Promise<boolean>;
};

export type McpOAuthRepository = {
  /** The connections of the workspace's servers. */
  list(): Promise<StoredMcpOAuth[]>;
  get(serverId: string): Promise<StoredMcpOAuth | undefined>;
  /** The connection with its sealed values and the version of the pair. */
  readSecrets(serverId: string): Promise<McpOAuthSecrets | undefined>;
  /**
   * Stores the grant of a finished flow (the discovery and the client it was made with, and the sealed token pair) in ONE statement, creating
   * the row when the server has none; false when the server is not there, is no longer at `expectedRevision` or no longer uses OAuth.
   */
  saveConnection(
    serverId: string,
    expectedRevision: number,
    input: SaveMcpOAuthConnection,
  ): Promise<boolean>;
  /**
   * Runs `work` in a transaction that holds the connection's row lock: it gets the row as it is now (undefined when there is none) and writes
   * for that row. Anything else that writes the row waits until `work` is done, so `work` may call the token endpoint: keep it to the one
   * refresh, which has its own deadline.
   */
  withLockedTokens<T>(
    serverId: string,
    work: (
      locked: McpOAuthSecrets | undefined,
      writes: LockedMcpOAuthWrites,
    ) => Promise<T>,
  ): Promise<T>;
};

/** The discovery as JSON text (the column, or what a started flow keeps in its state); null when it is not a discovery. */
export function parseMcpOAuthDiscovery(
  text: string | null,
): McpOAuthDiscovery | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<McpOAuthDiscovery> | null;
    if (
      value === null ||
      typeof value !== "object" ||
      typeof value.resource !== "string" ||
      typeof value.issuer !== "string" ||
      typeof value.authorizationEndpoint !== "string" ||
      typeof value.tokenEndpoint !== "string"
    )
      return null;
    const strings = (list: unknown): string[] =>
      Array.isArray(list)
        ? (list as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
    return {
      resource: value.resource,
      issuer: value.issuer,
      authorizationEndpoint: value.authorizationEndpoint,
      tokenEndpoint: value.tokenEndpoint,
      registrationEndpoint:
        typeof value.registrationEndpoint === "string"
          ? value.registrationEndpoint
          : null,
      scopes: strings(value.scopes),
      issParameter: value.issParameter === true,
      authMethods: strings(value.authMethods),
    };
  } catch {
    return null;
  }
}

const isOneOf = <T extends string>(
  list: readonly T[],
  value: string | null,
): value is T => value !== null && (list as readonly string[]).includes(value);

function toStored(row: Selectable<McpOauthConnectionsTable>): StoredMcpOAuth {
  return {
    serverId: row.server_id,
    workspaceId: row.workspace_id,
    status: isOneOf(MCP_OAUTH_STATUSES, row.status)
      ? row.status
      : "unconnected",
    errorCode: row.error_code,
    discovery: parseMcpOAuthDiscovery(row.discovery),
    clientSource: isOneOf(MCP_OAUTH_CLIENT_SOURCES, row.client_source)
      ? row.client_source
      : null,
    clientId: row.client_id,
    clientAuthMethod: isOneOf(MCP_OAUTH_AUTH_METHODS, row.client_auth_method)
      ? row.client_auth_method
      : null,
    hasClientSecret: row.client_secret_ciphertext !== null,
    registeredIssuer: row.registered_issuer,
    registeredRedirectUri: row.registered_redirect_uri,
    accessExpiresAt: row.access_expires_at,
    scopes:
      row.scopes === null || row.scopes === "" ? [] : row.scopes.split(" "),
    connectedBy: row.connected_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSecrets(row: Selectable<McpOauthConnectionsTable>): McpOAuthSecrets {
  return {
    oauth: toStored(row),
    clientSecret:
      row.client_secret_ciphertext === null ||
      row.client_secret_nonce === null ||
      row.client_secret_key_version === null
        ? null
        : {
            ciphertext: row.client_secret_ciphertext,
            nonce: row.client_secret_nonce,
            keyVersion: row.client_secret_key_version,
          },
    tokens:
      row.tokens_ciphertext === null ||
      row.tokens_nonce === null ||
      row.tokens_key_version === null
        ? null
        : {
            ciphertext: row.tokens_ciphertext,
            nonce: row.tokens_nonce,
            keyVersion: row.tokens_key_version,
          },
    tokenVersion: row.token_version,
  };
}

const clientColumns = (client: McpOAuthClient) => ({
  client_source: client.source,
  client_id: client.clientId,
  client_auth_method: client.authMethod,
  client_secret_ciphertext: client.sealedSecret?.ciphertext ?? null,
  client_secret_nonce: client.sealedSecret?.nonce ?? null,
  client_secret_key_version: client.sealedSecret?.keyVersion ?? null,
  registered_issuer: client.registeredIssuer ?? null,
  registered_redirect_uri: client.registeredRedirectUri ?? null,
});

/** Removes the connection of a server (its tokens, client and discovery); `executor` is the transaction that changes the server. */
export async function dropMcpOAuth(
  executor: Kysely<Database>,
  workspaceId: WorkspaceId,
  serverId: string,
): Promise<void> {
  await executor
    .deleteFrom("mcp_oauth_connections")
    .where("workspace_id", "=", workspaceId)
    .where("server_id", "=", serverId)
    .execute();
}

/** Gives the server a client entered by hand and nothing else: the old connection (another client's tokens) is gone. */
export async function replaceManualMcpOAuthClient(
  executor: Kysely<Database>,
  workspaceId: WorkspaceId,
  serverId: string,
  client: McpOAuthClient,
  at: Date,
): Promise<void> {
  await dropMcpOAuth(executor, workspaceId, serverId);
  await executor
    .insertInto("mcp_oauth_connections")
    .values({
      server_id: serverId,
      workspace_id: workspaceId,
      status: "unconnected",
      ...clientColumns(client),
      created_at: formatTimestamp(at),
      updated_at: formatTimestamp(at),
    })
    .execute();
}

async function writeTokens(
  executor: Kysely<Database>,
  workspaceId: WorkspaceId,
  serverId: string,
  expectedVersion: number,
  sealed: SealedBlob,
  accessExpiresAt: Date,
  scopes: string[] | null,
  at: Date,
): Promise<boolean> {
  const result = await executor
    .updateTable("mcp_oauth_connections")
    .set((eb) => ({
      tokens_ciphertext: sealed.ciphertext,
      tokens_nonce: sealed.nonce,
      tokens_key_version: sealed.keyVersion,
      token_version: eb("token_version", "+", 1),
      access_expires_at: formatTimestamp(accessExpiresAt),
      status: "connected",
      error_code: null,
      ...(scopes === null ? {} : { scopes: scopes.join(" ") }),
      updated_at: formatTimestamp(at),
    }))
    .where("workspace_id", "=", workspaceId)
    .where("server_id", "=", serverId)
    .where("token_version", "=", expectedVersion)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

async function writeBroken(
  executor: Kysely<Database>,
  workspaceId: WorkspaceId,
  serverId: string,
  expectedVersion: number,
  errorCode: string,
  at: Date,
): Promise<boolean> {
  const result = await executor
    .updateTable("mcp_oauth_connections")
    .set({
      status: "broken",
      error_code: errorCode,
      updated_at: formatTimestamp(at),
    })
    .where("workspace_id", "=", workspaceId)
    .where("server_id", "=", serverId)
    .where("token_version", "=", expectedVersion)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export function createMcpOAuthRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): McpOAuthRepository {
  /** The server's row locked `for share` when it is at the revision: an edit (`for no key update`) waits for the transaction. */
  async function serverAt(
    trx: Kysely<Database>,
    serverId: string,
    revision: number,
  ): Promise<boolean> {
    const server = await trx
      .selectFrom("mcp_servers")
      .select(["id", "revision", "auth_kind"])
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", serverId)
      .forShare()
      .executeTakeFirst();
    return (
      server !== undefined &&
      server.revision === revision &&
      server.auth_kind === "oauth"
    );
  }

  return {
    async list() {
      const rows = await db
        .selectFrom("mcp_oauth_connections")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy("server_id")
        .execute();
      return rows.map(toStored);
    },

    async get(serverId) {
      const row = await db
        .selectFrom("mcp_oauth_connections")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("server_id", "=", serverId)
        .executeTakeFirst();
      return row === undefined ? undefined : toStored(row);
    },

    async readSecrets(serverId) {
      const row = await db
        .selectFrom("mcp_oauth_connections")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("server_id", "=", serverId)
        .executeTakeFirst();
      return row === undefined ? undefined : toSecrets(row);
    },

    async saveConnection(serverId, expectedRevision, input) {
      const at = formatTimestamp(now());
      return db.transaction().execute(async (trx) => {
        if (!(await serverAt(trx, serverId, expectedRevision))) return false;
        const grant = {
          status: "connected",
          error_code: null,
          discovery: JSON.stringify(input.discovery),
          ...clientColumns(input.client),
          tokens_ciphertext: input.sealedTokens.ciphertext,
          tokens_nonce: input.sealedTokens.nonce,
          tokens_key_version: input.sealedTokens.keyVersion,
          access_expires_at: formatTimestamp(input.accessExpiresAt),
          scopes: input.scopes.join(" "),
          connected_by: input.connectedBy,
          updated_at: at,
        };
        const result = await trx
          .insertInto("mcp_oauth_connections")
          .values({
            server_id: serverId,
            workspace_id: workspaceId,
            ...grant,
            created_at: at,
          })
          .onConflict((conflict) =>
            conflict.column("server_id").doUpdateSet((eb) => ({
              ...grant,
              token_version: eb("mcp_oauth_connections.token_version", "+", 1),
            })),
          )
          .executeTakeFirst();
        return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
      });
    },

    withLockedTokens(serverId, work) {
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom("mcp_oauth_connections")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .where("server_id", "=", serverId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        return work(row === undefined ? undefined : toSecrets(row), {
          replaceTokens: (expectedVersion, sealed, accessExpiresAt, scopes) =>
            writeTokens(
              trx,
              workspaceId,
              serverId,
              expectedVersion,
              sealed,
              accessExpiresAt,
              scopes,
              now(),
            ),
          markBroken: (expectedVersion, errorCode) =>
            writeBroken(
              trx,
              workspaceId,
              serverId,
              expectedVersion,
              errorCode,
              now(),
            ),
        });
      });
    },
  };
}
