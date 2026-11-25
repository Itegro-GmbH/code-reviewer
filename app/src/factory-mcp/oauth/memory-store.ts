// SPDX-License-Identifier: LicenseRef-Proprietary

// An in-memory `OAuthStore` for the unit tests of the service and of the endpoint: the same contract as the Kysely repositories
// (`src/db/repositories/factory-oauth-*.ts`, proved against Postgres in their integration tests), without a database. Test use only.
import type {
  AuthorizationRequest,
  CodeLookup,
  CodeRecord,
  Grant,
  GrantView,
  OAuthClient,
  OAuthStore,
  TokenLookup,
  TokenRecord,
} from "./store.ts";

export type MemoryUser = { id: string; name: string; email: string };

export type MemoryStore = OAuthStore & {
  /** The rows, for assertions. */
  state: {
    clients: Map<string, OAuthClient>;
    requests: Map<string, AuthorizationRequest>;
    grants: Map<string, Grant>;
    codes: Map<string, CodeRecord>;
    tokens: Map<string, TokenRecord>;
  };
};

export function createMemoryStore(users: readonly MemoryUser[]): MemoryStore {
  const state: MemoryStore["state"] = {
    clients: new Map(),
    requests: new Map(),
    grants: new Map(),
    codes: new Map(),
    tokens: new Map(),
  };
  const userOf = (id: string): MemoryUser =>
    users.find((user) => user.id === id) ?? { id, name: id, email: `${id}@example.test` };

  function dropGrantRows(grantId: string): void {
    for (const [hash, code] of state.codes)
      if (code.grantId === grantId) state.codes.delete(hash);
    for (const [hash, token] of state.tokens)
      if (token.grantId === grantId) state.tokens.delete(hash);
  }

  return {
    state,
    directory: {
      async insertClient(client) {
        state.clients.set(client.id, client);
      },
      async findClient(id) {
        return state.clients.get(id) ?? null;
      },
      async countClients() {
        return state.clients.size;
      },
      async deleteUnusedClientsBefore(cutoff) {
        let removed = 0;
        for (const client of [...state.clients.values()]) {
          if (client.createdAt >= cutoff) continue;
          const used =
            [...state.grants.values()].some((grant) => grant.clientId === client.id) ||
            [...state.requests.values()].some((request) => request.clientId === client.id);
          if (used) continue;
          state.clients.delete(client.id);
          removed += 1;
        }
        return removed;
      },
      async insertRequest(request) {
        state.requests.set(request.id, request);
      },
      async findRequest(id, now) {
        const request = state.requests.get(id);
        return request !== undefined && request.expiresAt > now ? request : null;
      },
      async deleteRequest(id) {
        state.requests.delete(id);
      },
      async deleteExpiredRequests(now) {
        for (const [id, request] of state.requests)
          if (request.expiresAt <= now) state.requests.delete(id);
      },
      async findCode(codeHash): Promise<CodeLookup | null> {
        const code = state.codes.get(codeHash);
        const grant = code === undefined ? undefined : state.grants.get(code.grantId);
        return code === undefined || grant === undefined ? null : { code, grant };
      },
      async markCodeUsed(codeHash, now) {
        const code = state.codes.get(codeHash);
        if (code === undefined || code.usedAt !== null) return false;
        state.codes.set(codeHash, { ...code, usedAt: now });
        return true;
      },
      async insertTokens(tokens) {
        for (const token of tokens) state.tokens.set(token.tokenHash, token);
      },
      async findToken(tokenHash): Promise<TokenLookup | null> {
        const token = state.tokens.get(tokenHash);
        const grant = token === undefined ? undefined : state.grants.get(token.grantId);
        const client = grant === undefined ? undefined : state.clients.get(grant.clientId);
        if (token === undefined || grant === undefined || client === undefined) return null;
        return { token, grant, client: { id: client.id, name: client.name }, user: userOf(grant.userId) };
      },
      async markRefreshUsed(tokenHash, now) {
        const token = state.tokens.get(tokenHash);
        if (token === undefined || token.kind !== "refresh" || token.usedAt !== null) return false;
        state.tokens.set(tokenHash, { ...token, usedAt: now });
        return true;
      },
      async markGrantConnected(grantId, now) {
        const grant = state.grants.get(grantId);
        if (grant !== undefined && grant.connectedAt === null)
          state.grants.set(grantId, { ...grant, connectedAt: now });
      },
      async touchGrant(grantId, now, minIntervalMs) {
        const grant = state.grants.get(grantId);
        if (grant === undefined) return;
        const last = grant.lastUsedAt === null ? 0 : Date.parse(grant.lastUsedAt);
        if (Date.parse(now) - last >= minIntervalMs)
          state.grants.set(grantId, { ...grant, lastUsedAt: now });
      },
    },
    scoped(workspaceId) {
      return {
        async approve({ requestId, grant, code, now }) {
          if (grant.workspaceId !== workspaceId || code.workspaceId !== workspaceId)
            throw new Error("a grant of another workspace");
          if (!state.requests.delete(requestId)) return false;
          const staleBefore = new Date(Date.parse(now) - 60 * 60 * 1000).toISOString();
          for (const [id, other] of state.grants)
            if (
              other.workspaceId === workspaceId &&
              other.connectedAt === null &&
              other.createdAt < staleBefore
            ) {
              dropGrantRows(id);
              state.grants.delete(id);
            }
          state.grants.set(grant.id, grant);
          state.codes.set(code.codeHash, code);
          return true;
        },
        async list(): Promise<GrantView[]> {
          return [...state.grants.values()]
            .filter(
              (grant) =>
                grant.workspaceId === workspaceId &&
                grant.revokedAt === null &&
                grant.connectedAt !== null,
            )
            .sort((a, b) => (b.connectedAt ?? "").localeCompare(a.connectedAt ?? ""))
            .map((grant) => ({
              id: grant.id,
              clientId: grant.clientId,
              clientName: state.clients.get(grant.clientId)?.name ?? "",
              userId: grant.userId,
              userName: userOf(grant.userId).name,
              scopes: grant.scopes,
              connectedAt: grant.connectedAt as string,
              lastUsedAt: grant.lastUsedAt,
            }));
        },
        async revoke(grantId, now) {
          const grant = state.grants.get(grantId);
          if (grant === undefined || grant.workspaceId !== workspaceId || grant.revokedAt !== null)
            return false;
          state.grants.set(grantId, { ...grant, revokedAt: now });
          dropGrantRows(grantId);
          return true;
        },
      };
    },
  };
}
