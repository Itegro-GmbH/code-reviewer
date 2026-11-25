// SPDX-License-Identifier: LicenseRef-Proprietary

// The instance level side of the OAuth server of the factory MCP (#1144, epic #1143; the tables `factory_oauth_clients`,
// `factory_oauth_requests`, `factory_oauth_codes`, `factory_oauth_tokens`). It takes no workspace, for the reasons the classification
// in `scoping.test.ts` gives: an AI app registers itself before any workspace is known, a pending authorization request has not chosen a
// workspace yet, and a code or a token arrives holding nothing but its secret (the database keeps its hash), so the workspace is the
// ANSWER of the lookup, never the question. It never lists customer data; the rows of a grant that a workspace shows and revokes are
// in the scoped `factory-oauth-repository.ts`, and every write that changes a grant goes through that one.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import type {
  AuthorizationRequest,
  CodeLookup,
  Grant,
  OAuthClient,
  OAuthDirectory,
  TokenLookup,
  TokenKind,
} from "../factory-oauth-types.ts";
import { parseScopeList, type FactoryScope } from "../factory-oauth-types.ts";

/** The scopes of a stored space-separated value; a value this code did not write reads as none, so it grants nothing. */
export function scopesOfRow(value: string): FactoryScope[] {
  return parseScopeList(value) ?? [];
}

export function grantOfRow(row: {
  id: string;
  workspace_id: string;
  user_id: string;
  client_id: string;
  scope: string;
  resource: string;
  created_at: string;
  connected_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}): Grant {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    clientId: row.client_id,
    scopes: scopesOfRow(row.scope),
    resource: row.resource,
    createdAt: row.created_at,
    connectedAt: row.connected_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function clientOfRow(row: {
  id: string;
  name: string;
  redirect_uris: string;
  created_at: string;
}): OAuthClient {
  const parsed: unknown = JSON.parse(row.redirect_uris);
  return {
    id: row.id,
    name: row.name,
    redirectUris: Array.isArray(parsed)
      ? parsed.filter((uri): uri is string => typeof uri === "string")
      : [],
    createdAt: row.created_at,
  };
}

export type FactoryOAuthDirectoryRepository = OAuthDirectory & {
  /**
   * Housekeeping for the nightly clean-up, over every workspace, reading nothing: deletes the tokens and codes that expired before
   * `cutoff`, and the grants that were revoked, or never connected, before it. Returns the number of rows removed.
   */
  deleteExpired(cutoff: string): Promise<number>;
};

export function createFactoryOAuthDirectoryRepository(
  db: Kysely<Database>,
): FactoryOAuthDirectoryRepository {
  return {
    async insertClient(client) {
      await db
        .insertInto("factory_oauth_clients")
        .values({
          id: client.id,
          name: client.name,
          redirect_uris: JSON.stringify(client.redirectUris),
          created_at: client.createdAt,
        })
        .execute();
    },

    async findClient(id) {
      const row = await db
        .selectFrom("factory_oauth_clients")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? null : clientOfRow(row);
    },

    async countClients() {
      const row = await db
        .selectFrom("factory_oauth_clients")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async deleteUnusedClientsBefore(cutoff) {
      const result = await db
        .deleteFrom("factory_oauth_clients")
        .where("created_at", "<", cutoff)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("factory_oauth_grants")
                .select("factory_oauth_grants.id")
                .whereRef(
                  "factory_oauth_grants.client_id",
                  "=",
                  "factory_oauth_clients.id",
                ),
            ),
          ),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("factory_oauth_requests")
                .select("factory_oauth_requests.id")
                .whereRef(
                  "factory_oauth_requests.client_id",
                  "=",
                  "factory_oauth_clients.id",
                ),
            ),
          ),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },

    async insertRequest(request) {
      await db
        .insertInto("factory_oauth_requests")
        .values({
          id: request.id,
          client_id: request.clientId,
          redirect_uri: request.redirectUri,
          state: request.state,
          code_challenge: request.codeChallenge,
          scope: request.scopes.join(" "),
          resource: request.resource,
          created_at: request.createdAt,
          expires_at: request.expiresAt,
        })
        .execute();
    },

    async findRequest(id, now): Promise<AuthorizationRequest | null> {
      const row = await db
        .selectFrom("factory_oauth_requests")
        .selectAll()
        .where("id", "=", id)
        .where("expires_at", ">", now)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        id: row.id,
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        state: row.state,
        codeChallenge: row.code_challenge,
        scopes: scopesOfRow(row.scope),
        resource: row.resource,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
    },

    async deleteRequest(id) {
      await db
        .deleteFrom("factory_oauth_requests")
        .where("id", "=", id)
        .execute();
    },

    async deleteExpiredRequests(now) {
      await db
        .deleteFrom("factory_oauth_requests")
        .where("expires_at", "<=", now)
        .execute();
    },

    async findCode(codeHash): Promise<CodeLookup | null> {
      const code = await db
        .selectFrom("factory_oauth_codes")
        .selectAll()
        .where("code_hash", "=", codeHash)
        .executeTakeFirst();
      if (code === undefined) return null;
      const grant = await db
        .selectFrom("factory_oauth_grants")
        .selectAll()
        .where("id", "=", code.grant_id)
        .executeTakeFirst();
      if (grant === undefined) return null;
      return {
        code: {
          codeHash: code.code_hash,
          grantId: code.grant_id,
          workspaceId: code.workspace_id,
          clientId: code.client_id,
          redirectUri: code.redirect_uri,
          codeChallenge: code.code_challenge,
          expiresAt: code.expires_at,
          usedAt: code.used_at,
        },
        grant: grantOfRow(grant),
      };
    },

    async markCodeUsed(codeHash, now) {
      const result = await db
        .updateTable("factory_oauth_codes")
        .set({ used_at: now })
        .where("code_hash", "=", codeHash)
        .where("used_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async insertTokens(tokens) {
      if (tokens.length === 0) return;
      await db
        .insertInto("factory_oauth_tokens")
        .values(
          tokens.map((token) => ({
            token_hash: token.tokenHash,
            grant_id: token.grantId,
            workspace_id: token.workspaceId,
            kind: token.kind,
            created_at: token.createdAt,
            expires_at: token.expiresAt,
            used_at: token.usedAt,
          })),
        )
        .execute();
    },

    async findToken(tokenHash): Promise<TokenLookup | null> {
      const row = await db
        .selectFrom("factory_oauth_tokens as t")
        .innerJoin("factory_oauth_grants as g", "g.id", "t.grant_id")
        .innerJoin("factory_oauth_clients as c", "c.id", "g.client_id")
        .innerJoin("users as u", "u.id", "g.user_id")
        .select([
          "t.token_hash as t_hash",
          "t.kind as t_kind",
          "t.grant_id as t_grant",
          "t.workspace_id as t_workspace",
          "t.created_at as t_created",
          "t.expires_at as t_expires",
          "t.used_at as t_used",
          "g.id as g_id",
          "g.workspace_id as g_workspace",
          "g.user_id as g_user",
          "g.client_id as g_client",
          "g.scope as g_scope",
          "g.resource as g_resource",
          "g.created_at as g_created",
          "g.connected_at as g_connected",
          "g.last_used_at as g_last_used",
          "g.revoked_at as g_revoked",
          "c.name as c_name",
          "u.name as u_name",
          "u.email as u_email",
        ])
        .where("t.token_hash", "=", tokenHash)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        token: {
          tokenHash: row.t_hash,
          kind: row.t_kind as TokenKind,
          grantId: row.t_grant,
          workspaceId: row.t_workspace,
          createdAt: row.t_created,
          expiresAt: row.t_expires,
          usedAt: row.t_used,
        },
        grant: grantOfRow({
          id: row.g_id,
          workspace_id: row.g_workspace,
          user_id: row.g_user,
          client_id: row.g_client,
          scope: row.g_scope,
          resource: row.g_resource,
          created_at: row.g_created,
          connected_at: row.g_connected,
          last_used_at: row.g_last_used,
          revoked_at: row.g_revoked,
        }),
        client: { id: row.g_client, name: row.c_name },
        user: { id: row.g_user, name: row.u_name, email: row.u_email },
      };
    },

    async markRefreshUsed(tokenHash, now) {
      const result = await db
        .updateTable("factory_oauth_tokens")
        .set({ used_at: now })
        .where("token_hash", "=", tokenHash)
        .where("kind", "=", "refresh")
        .where("used_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async markGrantConnected(grantId, now) {
      await db
        .updateTable("factory_oauth_grants")
        .set({ connected_at: now })
        .where("id", "=", grantId)
        .where("connected_at", "is", null)
        .execute();
    },

    async touchGrant(grantId, now, minIntervalMs) {
      const before = formatTimestamp(new Date(Date.parse(now) - minIntervalMs));
      await db
        .updateTable("factory_oauth_grants")
        .set({ last_used_at: now })
        .where("id", "=", grantId)
        .where((eb) =>
          eb.or([
            eb("last_used_at", "is", null),
            eb("last_used_at", "<=", before),
          ]),
        )
        .execute();
    },

    async deleteExpired(cutoff) {
      const tokens = await db
        .deleteFrom("factory_oauth_tokens")
        .where("expires_at", "<", cutoff)
        .executeTakeFirst();
      const codes = await db
        .deleteFrom("factory_oauth_codes")
        .where("expires_at", "<", cutoff)
        .executeTakeFirst();
      const grants = await db
        .deleteFrom("factory_oauth_grants")
        .where((eb) =>
          eb.or([
            eb("revoked_at", "<", cutoff),
            eb.and([
              eb("connected_at", "is", null),
              eb("created_at", "<", cutoff),
            ]),
          ]),
        )
        .executeTakeFirst();
      return (
        Number(tokens.numDeletedRows) +
        Number(codes.numDeletedRows) +
        Number(grants.numDeletedRows)
      );
    },
  };
}
