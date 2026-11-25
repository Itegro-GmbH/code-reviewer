// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the grants of ONE workspace (the table `factory_oauth_grants`, with its codes and tokens; the factory takes the workspace
// id, see ../workspace-scope.ts): what a person approved for an AI app (#1144, epic #1143). Making a grant (the consent), the list of
// "Connected AI apps" and revoking one. Customer data, workspace scoped; the lookups by the hash of a code or a token, which hold no
// workspace yet, are in `factory-oauth-directory-repository.ts`.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import type { GrantView, ScopedGrants } from "../factory-oauth-types.ts";
import { scopesOfRow } from "./factory-oauth-directory-repository.ts";

/** A grant whose code was never exchanged is removed after this long. */
export const UNCONNECTED_GRANT_TTL_MS = 60 * 60 * 1000;

export type FactoryOAuthRepository = ScopedGrants;

export function createFactoryOAuthRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
): FactoryOAuthRepository {
  return {
    async approve({ requestId, grant, code, now }) {
      if (grant.workspaceId !== workspaceId || code.workspaceId !== workspaceId)
        throw new Error(
          "A grant can only be made in the workspace of this repository.",
        );
      const run = async (executor: Kysely<Database>): Promise<boolean> => {
        // The request is answered once: whoever deletes the row owns the answer.
        const taken = await executor
          .deleteFrom("factory_oauth_requests")
          .where("id", "=", requestId)
          .executeTakeFirst();
        if (Number(taken.numDeletedRows) !== 1) return false;
        await executor
          .deleteFrom("factory_oauth_grants")
          .where("workspace_id", "=", workspaceId)
          .where("connected_at", "is", null)
          .where(
            "created_at",
            "<",
            formatTimestamp(
              new Date(Date.parse(now) - UNCONNECTED_GRANT_TTL_MS),
            ),
          )
          .execute();
        await executor
          .insertInto("factory_oauth_grants")
          .values({
            id: grant.id,
            workspace_id: workspaceId,
            user_id: grant.userId,
            client_id: grant.clientId,
            scope: grant.scopes.join(" "),
            resource: grant.resource,
            created_at: grant.createdAt,
            connected_at: null,
            last_used_at: null,
            revoked_at: null,
          })
          .execute();
        await executor
          .insertInto("factory_oauth_codes")
          .values({
            code_hash: code.codeHash,
            grant_id: grant.id,
            workspace_id: workspaceId,
            client_id: code.clientId,
            redirect_uri: code.redirectUri,
            code_challenge: code.codeChallenge,
            expires_at: code.expiresAt,
            used_at: null,
          })
          .execute();
        return true;
      };
      if (db.isTransaction) return run(db);
      return db.transaction().execute(run);
    },

    async list(): Promise<GrantView[]> {
      const rows = await db
        .selectFrom("factory_oauth_grants as g")
        .innerJoin("factory_oauth_clients as c", "c.id", "g.client_id")
        .innerJoin("users as u", "u.id", "g.user_id")
        .select([
          "g.id as id",
          "g.client_id as client_id",
          "c.name as client_name",
          "g.user_id as user_id",
          "u.name as user_name",
          "g.scope as scope",
          "g.connected_at as connected_at",
          "g.last_used_at as last_used_at",
        ])
        .where("g.workspace_id", "=", workspaceId)
        .where("g.revoked_at", "is", null)
        .where("g.connected_at", "is not", null)
        .orderBy("g.connected_at", "desc")
        .orderBy("g.id")
        .execute();
      return rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        clientName: row.client_name,
        userId: row.user_id,
        userName: row.user_name,
        scopes: scopesOfRow(row.scope),
        connectedAt: row.connected_at as string,
        lastUsedAt: row.last_used_at,
      }));
    },

    async markConnected(grantId, now) {
      await db
        .updateTable("factory_oauth_grants")
        .set({ connected_at: now })
        .where("id", "=", grantId)
        .where("workspace_id", "=", workspaceId)
        .where("connected_at", "is", null)
        .execute();
    },

    async touch(grantId, now, minIntervalMs) {
      const before = formatTimestamp(new Date(Date.parse(now) - minIntervalMs));
      await db
        .updateTable("factory_oauth_grants")
        .set({ last_used_at: now })
        .where("id", "=", grantId)
        .where("workspace_id", "=", workspaceId)
        .where((eb) =>
          eb.or([
            eb("last_used_at", "is", null),
            eb("last_used_at", "<=", before),
          ]),
        )
        .execute();
    },

    async revoke(grantId, now) {
      const run = async (executor: Kysely<Database>): Promise<boolean> => {
        const result = await executor
          .updateTable("factory_oauth_grants")
          .set({ revoked_at: now })
          .where("id", "=", grantId)
          .where("workspace_id", "=", workspaceId)
          .where("revoked_at", "is", null)
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) !== 1) return false;
        await executor
          .deleteFrom("factory_oauth_codes")
          .where("grant_id", "=", grantId)
          .where("workspace_id", "=", workspaceId)
          .execute();
        await executor
          .deleteFrom("factory_oauth_tokens")
          .where("grant_id", "=", grantId)
          .where("workspace_id", "=", workspaceId)
          .execute();
        return true;
      };
      if (db.isTransaction) return run(db);
      return db.transaction().execute(run);
    },
  };
}
