// SPDX-License-Identifier: LicenseRef-Proprietary

// The vocabulary the OAuth server of the factory MCP stores (#1144, epic #1143), in the database layer like `workspace-roles.ts`: the two scopes
// and the types of the rows of its tables as the service sees them. The repositories (`repositories/factory-oauth-*.ts`) speak these types,
// and `src/factory-mcp/` imports them, so the database layer imports nothing of the factory MCP.

export const FACTORY_SCOPES = ["factory:read", "factory:control"] as const;
export type FactoryScope = (typeof FACTORY_SCOPES)[number];

export function isFactoryScope(value: unknown): value is FactoryScope {
  return FACTORY_SCOPES.some((scope) => scope === value);
}

/** The scopes of a space-separated value; `null` when it names anything that is not ours (nothing is dropped silently). */
export function parseScopeList(
  value: string | null | undefined,
): FactoryScope[] | null {
  if (value === null || value === undefined) return [];
  const names = value.split(" ").filter((name) => name !== "");
  const scopes: FactoryScope[] = [];
  for (const name of names) {
    if (!isFactoryScope(name)) return null;
    if (!scopes.includes(name)) scopes.push(name);
  }
  return scopes;
}

/** The space-separated text of a list, in the order of `FACTORY_SCOPES`. */
export function formatScopeList(scopes: readonly FactoryScope[]): string {
  return FACTORY_SCOPES.filter((scope) => scopes.includes(scope)).join(" ");
}

export type OAuthClient = {
  id: string;
  /** What the client called itself at registration, cleaned. Shown on the consent page next to where the code goes; never trusted. */
  name: string;
  redirectUris: string[];
  createdAt: string;
};

export type AuthorizationRequest = {
  id: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  /** What the client asked for; empty when it named no scope. */
  scopes: FactoryScope[];
  resource: string;
  createdAt: string;
  expiresAt: string;
};

export type Grant = {
  id: string;
  workspaceId: string;
  userId: string;
  clientId: string;
  /** What the person approved. */
  scopes: FactoryScope[];
  /** The audience every token of the grant is bound to (RFC 8707): the MCP endpoint's address. */
  resource: string;
  createdAt: string;
  /** Set when the code was exchanged; a grant whose code never was is not listed and is cleaned up. */
  connectedAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type CodeRecord = {
  codeHash: string;
  grantId: string;
  workspaceId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: string;
  usedAt: string | null;
};

export type TokenKind = "access" | "refresh";

export type TokenRecord = {
  tokenHash: string;
  kind: TokenKind;
  grantId: string;
  workspaceId: string;
  createdAt: string;
  expiresAt: string;
  /** A refresh token is used once (rotation); an access token has none. */
  usedAt: string | null;
};

export type TokenLookup = {
  token: TokenRecord;
  grant: Grant;
  client: { id: string; name: string };
  user: { id: string; name: string; email: string };
};

export type CodeLookup = { code: CodeRecord; grant: Grant };

/** A row of the list of connected AI apps. */
export type GrantView = {
  id: string;
  clientId: string;
  clientName: string;
  userId: string;
  userName: string;
  scopes: FactoryScope[];
  connectedAt: string;
  lastUsedAt: string | null;
};

export type OAuthDirectory = {
  insertClient(client: OAuthClient): Promise<void>;
  findClient(id: string): Promise<OAuthClient | null>;
  countClients(): Promise<number>;
  /** Removes clients registered before `cutoff` that no grant and no pending request uses. Returns how many. */
  deleteUnusedClientsBefore(cutoff: string): Promise<number>;

  insertRequest(request: AuthorizationRequest): Promise<void>;
  /** A request that has not expired at `now`. */
  findRequest(id: string, now: string): Promise<AuthorizationRequest | null>;
  deleteRequest(id: string): Promise<void>;
  deleteExpiredRequests(now: string): Promise<void>;

  findCode(codeHash: string): Promise<CodeLookup | null>;
  /** Marks the code used; false when it already was (a second use of a code is an attack or a bug, the grant is revoked). */
  markCodeUsed(codeHash: string, now: string): Promise<boolean>;
  insertTokens(tokens: readonly TokenRecord[]): Promise<void>;
  findToken(tokenHash: string): Promise<TokenLookup | null>;
  /** Marks a refresh token used; false when it already was (one statement, so two requests cannot both win). */
  markRefreshUsed(tokenHash: string, now: string): Promise<boolean>;
  markGrantConnected(grantId: string, now: string): Promise<void>;
  /** Records that the grant was used, at most once per `minIntervalMs`. */
  touchGrant(
    grantId: string,
    now: string,
    minIntervalMs: number,
  ): Promise<void>;
};

export type ScopedGrants = {
  /**
   * The consent: removes the pending request and makes the grant and the code in one transaction. False when the request is gone
   * already (it can be approved once). Also removes the grants of this workspace that were never connected and are older than an hour.
   */
  approve(input: {
    requestId: string;
    grant: Grant;
    code: CodeRecord;
    now: string;
  }): Promise<boolean>;
  /** The connected apps that are not revoked, newest first. */
  list(): Promise<GrantView[]>;
  /** Revokes the grant and deletes its codes and tokens. False for a grant of another workspace, one that is gone or revoked already. */
  revoke(grantId: string, now: string): Promise<boolean>;
};

export type OAuthStore = {
  directory: OAuthDirectory;
  scoped(workspaceId: string): ScopedGrants;
};
