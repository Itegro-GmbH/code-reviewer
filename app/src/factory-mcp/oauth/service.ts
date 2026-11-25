// SPDX-License-Identifier: LicenseRef-Proprietary

// The OAuth 2.1 authorization server of the factory MCP (epic #1143, issue #1144), the part that decides. Pure over the store port
// (`store.ts`), the memberships and the clock, so every rule is proved without a database or a server. The HTTP shapes are in
// `http.ts`, the pages in `src/app/oauth/`.
//
// What the MCP authorization specification (2025-06-18) and OAuth 2.1 ask, and where it is decided:
//
// - Public clients registered dynamically (RFC 7591): `registerClient`. No client secret exists; every client uses PKCE.
// - The authorization code flow with PKCE, S256 only, for every request: `beginAuthorization`, `decide`, `exchange`. A request
//   without a challenge is refused, `plain` is refused.
// - The redirect URI is compared exactly to the registered ones (`redirect-uri.ts`); an unknown client or redirect URI is shown as an
//   error page and never redirected to; the `iss` parameter (RFC 9207) is in every answer to the client.
// - Resource indicators (RFC 8707) and audience binding: the only resource is the endpoint's own address; a request that names another is
//   `invalid_target`; every grant carries it and `authenticate` refuses a token whose grant names another audience.
// - Short lived access tokens (15 minutes) and rotating refresh tokens with reuse detection: a refresh token is spent when used; the
//   spent token coming back after a short grace is taken as theft and ends the whole grant. A grant lives 90 days at most.
// - The code is single use and lives 60 seconds; a second use ends the grant.
// - Every use re-reads the person's membership: a token never outlives the person's access to the workspace, and the role is the one
//   they have now.
import { formatTimestamp } from "../../db/codecs.ts";
import type { Membership } from "../../db/repositories/workspaces-repository.ts";
import type { WorkspaceRole } from "../../db/workspace-roles.ts";
import {
  FACTORY_SCOPES,
  formatScopeList,
  isFactoryScope,
  parseScopeList,
  type FactoryScope,
} from "../scopes.ts";
import {
  checkRedirectUri,
  redirectTargetLabel,
  redirectUriMatches,
} from "./redirect-uri.ts";
import type {
  AuthorizationRequest,
  Grant,
  OAuthClient,
  OAuthStore,
  TokenRecord,
} from "./store.ts";
import {
  CODE_CHALLENGE_PATTERN,
  REQUEST_ID_PATTERN,
  hashSecret,
  looksLikeSecret,
  newRequestId,
  newRowId,
  newSecret,
  verifyPkce,
} from "./tokens.ts";

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_IDLE_TTL_MS = 30 * 24 * 3600 * 1000;
export const GRANT_MAX_AGE_MS = 90 * 24 * 3600 * 1000;
export const CODE_TTL_MS = 60 * 1000;
export const REQUEST_TTL_MS = 10 * 60 * 1000;
/** A spent refresh token presented again within this time is a retry (a lost answer), not theft. */
export const REFRESH_REUSE_GRACE_MS = 10 * 1000;
/** How often a grant's "last used" is written at most. */
export const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;
export const REDIRECT_URIS_MAX = 10;
export const CLIENT_NAME_MAX_LENGTH = 100;
/** Registered clients the server keeps at most; registration is open to anybody, so the table is bounded. */
export const CLIENTS_MAX = 5000;
/** A client nobody authorized is removed after a day. */
export const UNUSED_CLIENT_TTL_MS = 24 * 3600 * 1000;
export const STATE_MAX_LENGTH = 1024;

export type OAuthConfig = {
  /** The public address of the app, the issuer of the metadata. */
  issuer: string;
  /** The address of the MCP endpoint, the only audience a token can have. */
  resource: string;
};

export type OAuthServiceDependencies = {
  store: OAuthStore;
  memberships: {
    findMembershipById(
      userId: string,
      workspaceId: string,
    ): Promise<Membership | undefined>;
    listForUser(userId: string): Promise<Membership[]>;
  };
  config: OAuthConfig;
  now?: () => Date;
};

export type ClientRegistrationResponse = {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  scope: string;
};

export type RegistrationOutcome =
  | { kind: "ok"; response: ClientRegistrationResponse }
  | {
      kind: "error";
      error:
        | "invalid_redirect_uri"
        | "invalid_client_metadata"
        | "temporarily_unavailable";
      description: string;
    };

export type AuthorizeOutcome =
  | { kind: "request"; requestId: string }
  /** The client or the redirect URI cannot be trusted: shown as a page, never redirected to. */
  | {
      kind: "page_error";
      code: "invalid_client" | "invalid_redirect_uri";
      description: string;
    }
  | { kind: "redirect_error"; redirectTo: string };

export type ConsentView = {
  requestId: string;
  client: { id: string; name: string };
  /** Where the code will be sent, as a person can judge it: the host, or the scheme of an app. */
  redirectTarget: string;
  requestedScopes: FactoryScope[];
  /** What the person may choose between: the requested scopes, or both when the client named none. */
  allowedScopes: FactoryScope[];
  workspaces: { id: string; slug: string; name: string; role: WorkspaceRole }[];
};

export type DecisionOutcome =
  | { kind: "redirect"; redirectTo: string }
  | {
      kind: "invalid";
      code: "request_not_found" | "workspace_invalid" | "scope_invalid";
    };

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

export type TokenErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "invalid_scope"
  | "invalid_target"
  | "unsupported_grant_type";

export type ExchangeOutcome =
  | { kind: "ok"; body: TokenResponse }
  | {
      kind: "error";
      error: TokenErrorCode;
      description: string;
    };

export type Principal = {
  grantId: string;
  user: { id: string; name: string; email: string };
  workspace: { id: string; slug: string; name: string };
  /** The role the person has NOW in the workspace. */
  role: WorkspaceRole;
  /** What the person approved. */
  scopes: FactoryScope[];
  client: { id: string; name: string };
  connectedAt: string | null;
  tokenExpiresAt: string;
};

export type AuthenticateOutcome =
  | { kind: "ok"; principal: Principal }
  | {
      kind: "error";
      error: "invalid_request" | "invalid_token";
      description: string;
    };

export type OAuthService = ReturnType<typeof createOAuthService>;

/** A resource identifier compared as the endpoint's address: scheme and host in lower case, no trailing slash, no query, no fragment. */
export function normalizeResource(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.search !== "" || url.hash !== "") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * What is taken out of a client's name: C0 and C1 controls, zero width and direction marks (U+200B to U+200F, U+2028 to U+202E,
 * U+2060 to U+2069) and the byte order mark. Written as escapes so the source holds no invisible character.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_AND_DIRECTION_CHARACTERS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]",
  "g",
);

/** The name a client gave itself, made safe to show: no control or direction characters, one line, at most 100 characters. */
export function cleanClientName(value: unknown): string {
  if (typeof value !== "string") return "Unnamed app";
  const cleaned = value
    .replace(CONTROL_AND_DIRECTION_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cut = Array.from(cleaned)
    .slice(0, CLIENT_NAME_MAX_LENGTH)
    .join("")
    .trim();
  return cut === "" ? "Unnamed app" : cut;
}

type Single =
  { kind: "value"; value: string } | { kind: "absent" } | { kind: "repeated" };

function single(params: URLSearchParams, name: string): Single {
  const all = params.getAll(name);
  if (all.length === 0) return { kind: "absent" };
  if (all.length > 1) return { kind: "repeated" };
  return { kind: "value", value: all[0] as string };
}

function withIssuer(target: URL, issuer: string): URL {
  target.searchParams.set("iss", issuer);
  return target;
}

export function createOAuthService({
  store,
  memberships,
  config,
  now = () => new Date(),
}: OAuthServiceDependencies) {
  const { directory } = store;
  const resourceKey = normalizeResource(config.resource);
  if (resourceKey === null)
    throw new Error("The MCP resource address is not a valid address.");

  const at = (date = now()): string => formatTimestamp(date);
  const after = (ms: number): string =>
    formatTimestamp(new Date(now().getTime() + ms));

  function redirectError(
    redirectUri: string,
    state: string | null,
    error: string,
    description: string,
  ): { kind: "redirect_error"; redirectTo: string } {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (state !== null) target.searchParams.set("state", state);
    return {
      kind: "redirect_error",
      redirectTo: withIssuer(target, config.issuer).toString(),
    };
  }

  function tokenError(
    error: TokenErrorCode,
    description: string,
  ): ExchangeOutcome {
    return { kind: "error", error, description };
  }

  /** A new access and refresh token for the grant; only their hashes are stored. */
  async function issueTokens(grant: Grant): Promise<TokenResponse> {
    const access = newSecret("access");
    const refresh = newSecret("refresh");
    const created = at();
    const grantEnd = Date.parse(grant.createdAt) + GRANT_MAX_AGE_MS;
    const refreshEnd = Math.min(
      now().getTime() + REFRESH_TOKEN_IDLE_TTL_MS,
      grantEnd,
    );
    const records: TokenRecord[] = [
      {
        tokenHash: hashSecret(access),
        kind: "access",
        grantId: grant.id,
        workspaceId: grant.workspaceId,
        createdAt: created,
        expiresAt: after(ACCESS_TOKEN_TTL_MS),
        usedAt: null,
      },
      {
        tokenHash: hashSecret(refresh),
        kind: "refresh",
        grantId: grant.id,
        workspaceId: grant.workspaceId,
        createdAt: created,
        expiresAt: formatTimestamp(new Date(refreshEnd)),
        usedAt: null,
      },
    ];
    await directory.insertTokens(records);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refresh,
      scope: formatScopeList(grant.scopes),
    };
  }

  async function revokeGrant(
    grant: Pick<Grant, "id" | "workspaceId">,
  ): Promise<void> {
    await store.scoped(grant.workspaceId).revoke(grant.id, at());
  }

  /** Whether the person still belongs to the workspace of the grant; if not, the grant ends. */
  async function stillMember(grant: Grant): Promise<Membership | undefined> {
    const membership = await memberships.findMembershipById(
      grant.userId,
      grant.workspaceId,
    );
    if (membership === undefined) await revokeGrant(grant);
    return membership;
  }

  function checkResource(params: URLSearchParams): "ok" | "invalid" {
    const given = single(params, "resource");
    if (given.kind === "absent") return "ok";
    if (given.kind === "repeated") return "invalid";
    return normalizeResource(given.value) === resourceKey ? "ok" : "invalid";
  }

  return {
    async registerClient(body: unknown): Promise<RegistrationOutcome> {
      const invalid = (description: string): RegistrationOutcome => ({
        kind: "error",
        error: "invalid_client_metadata",
        description,
      });
      if (typeof body !== "object" || body === null || Array.isArray(body))
        return invalid("The body must be a JSON object.");
      const meta = body as Record<string, unknown>;

      const uris = meta.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0)
        return {
          kind: "error",
          error: "invalid_redirect_uri",
          description:
            "redirect_uris must be a list with at least one address.",
        };
      if (uris.length > REDIRECT_URIS_MAX)
        return {
          kind: "error",
          error: "invalid_redirect_uri",
          description: `At most ${REDIRECT_URIS_MAX} redirect URIs.`,
        };
      const redirectUris: string[] = [];
      for (const uri of uris) {
        const checked = checkRedirectUri(uri);
        if (!checked.ok)
          return {
            kind: "error",
            error: "invalid_redirect_uri",
            description: checked.reason,
          };
        if (!redirectUris.includes(checked.uri)) redirectUris.push(checked.uri);
      }

      const grantTypes = meta.grant_types ?? [
        "authorization_code",
        "refresh_token",
      ];
      if (
        !Array.isArray(grantTypes) ||
        !grantTypes.includes("authorization_code") ||
        !grantTypes.every(
          (type) => type === "authorization_code" || type === "refresh_token",
        )
      )
        return invalid(
          "grant_types may hold authorization_code and refresh_token only, and must hold authorization_code.",
        );
      const responseTypes = meta.response_types ?? ["code"];
      if (
        !Array.isArray(responseTypes) ||
        responseTypes.length !== 1 ||
        responseTypes[0] !== "code"
      )
        return invalid('response_types must be ["code"].');
      const method = meta.token_endpoint_auth_method ?? "none";
      if (method !== "none")
        return invalid(
          "Only public clients are supported: token_endpoint_auth_method must be none (PKCE protects the code).",
        );
      let scope = formatScopeList(FACTORY_SCOPES);
      if (meta.scope !== undefined) {
        const parsed =
          typeof meta.scope === "string" ? parseScopeList(meta.scope) : null;
        if (parsed === null)
          return invalid(
            "scope may name factory:read and factory:control only.",
          );
        if (parsed.length > 0) scope = formatScopeList(parsed);
      }

      await directory.deleteUnusedClientsBefore(after(-UNUSED_CLIENT_TTL_MS));
      await directory.deleteExpiredRequests(at());
      if ((await directory.countClients()) >= CLIENTS_MAX)
        return {
          kind: "error",
          error: "temporarily_unavailable",
          description: "Too many clients are registered; try again later.",
        };

      const client: OAuthClient = {
        id: newRowId(),
        name: cleanClientName(meta.client_name),
        redirectUris,
        createdAt: at(),
      };
      await directory.insertClient(client);
      return {
        kind: "ok",
        response: {
          client_id: client.id,
          client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
          client_name: client.name,
          redirect_uris: client.redirectUris,
          grant_types: [...(grantTypes as string[])],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope,
        },
      };
    },

    async beginAuthorization(
      params: URLSearchParams,
    ): Promise<AuthorizeOutcome> {
      const clientId = single(params, "client_id");
      const client =
        clientId.kind === "value"
          ? await directory.findClient(clientId.value)
          : null;
      if (client === null)
        return {
          kind: "page_error",
          code: "invalid_client",
          description: "The client is not registered.",
        };
      const requested = single(params, "redirect_uri");
      if (requested.kind === "repeated")
        return {
          kind: "page_error",
          code: "invalid_redirect_uri",
          description: "redirect_uri is given more than once.",
        };
      const redirectUri =
        requested.kind === "value"
          ? requested.value
          : client.redirectUris.length === 1
            ? (client.redirectUris[0] as string)
            : null;
      if (
        redirectUri === null ||
        !redirectUriMatches(client.redirectUris, redirectUri)
      )
        return {
          kind: "page_error",
          code: "invalid_redirect_uri",
          description: "The redirect URI is not one the client registered.",
        };

      // From here on the redirect URI is trusted and errors go to the client.
      const stateParam = single(params, "state");
      if (
        stateParam.kind === "repeated" ||
        (stateParam.kind === "value" &&
          stateParam.value.length > STATE_MAX_LENGTH)
      )
        return redirectError(
          redirectUri,
          null,
          "invalid_request",
          "state is given more than once or too long.",
        );
      const state = stateParam.kind === "value" ? stateParam.value : null;
      const fail = (error: string, description: string) =>
        redirectError(redirectUri, state, error, description);

      const responseType = single(params, "response_type");
      if (responseType.kind !== "value" || responseType.value !== "code")
        return fail(
          "unsupported_response_type",
          "Only response_type=code is supported.",
        );
      const challenge = single(params, "code_challenge");
      const method = single(params, "code_challenge_method");
      if (
        challenge.kind !== "value" ||
        !CODE_CHALLENGE_PATTERN.test(challenge.value) ||
        method.kind !== "value" ||
        method.value !== "S256"
      )
        return fail(
          "invalid_request",
          "PKCE with code_challenge_method=S256 is required.",
        );
      const scopeParam = single(params, "scope");
      if (scopeParam.kind === "repeated")
        return fail("invalid_scope", "scope is given more than once.");
      const scopes = parseScopeList(
        scopeParam.kind === "value" ? scopeParam.value : null,
      );
      if (scopes === null)
        return fail(
          "invalid_scope",
          "Only factory:read and factory:control exist.",
        );
      if (checkResource(params) === "invalid")
        return fail(
          "invalid_target",
          `The only resource is ${config.resource}.`,
        );

      await directory.deleteExpiredRequests(at());
      const request: AuthorizationRequest = {
        id: newRequestId(),
        clientId: client.id,
        redirectUri,
        state,
        codeChallenge: challenge.value,
        scopes,
        resource: config.resource,
        createdAt: at(),
        expiresAt: after(REQUEST_TTL_MS),
      };
      await directory.insertRequest(request);
      return { kind: "request", requestId: request.id };
    },

    /** What the consent page shows, or null when the request is unknown or has expired. */
    async describeRequest(
      requestId: string,
      userId: string,
    ): Promise<ConsentView | null> {
      if (!REQUEST_ID_PATTERN.test(requestId)) return null;
      const request = await directory.findRequest(requestId, at());
      if (request === null) return null;
      const client = await directory.findClient(request.clientId);
      if (client === null) return null;
      const memberOf = await memberships.listForUser(userId);
      return {
        requestId,
        client: { id: client.id, name: client.name },
        redirectTarget: redirectTargetLabel(request.redirectUri),
        requestedScopes: request.scopes,
        allowedScopes:
          request.scopes.length > 0 ? request.scopes : [...FACTORY_SCOPES],
        workspaces: memberOf.map(({ workspace, role }) => ({
          id: workspace.id,
          slug: workspace.slug,
          name: workspace.name,
          role,
        })),
      };
    },

    /** The person's answer on the consent page: one workspace and one scope, or a refusal. */
    async decide(input: {
      requestId: string;
      userId: string;
      decision: "approve" | "deny";
      workspaceId?: string | undefined;
      scope?: string | undefined;
    }): Promise<DecisionOutcome> {
      if (!REQUEST_ID_PATTERN.test(input.requestId))
        return { kind: "invalid", code: "request_not_found" };
      const request = await directory.findRequest(input.requestId, at());
      const client =
        request === null ? null : await directory.findClient(request.clientId);
      if (request === null || client === null)
        return { kind: "invalid", code: "request_not_found" };

      if (input.decision === "deny") {
        await directory.deleteRequest(request.id);
        const target = new URL(request.redirectUri);
        target.searchParams.set("error", "access_denied");
        target.searchParams.set(
          "error_description",
          "The user denied the request.",
        );
        if (request.state !== null)
          target.searchParams.set("state", request.state);
        return {
          kind: "redirect",
          redirectTo: withIssuer(target, config.issuer).toString(),
        };
      }

      const membership =
        input.workspaceId === undefined || input.workspaceId === ""
          ? undefined
          : await memberships.findMembershipById(
              input.userId,
              input.workspaceId,
            );
      if (membership === undefined)
        return { kind: "invalid", code: "workspace_invalid" };
      const allowed =
        request.scopes.length > 0 ? request.scopes : [...FACTORY_SCOPES];
      const chosen =
        input.scope === undefined ? null : parseScopeList(input.scope);
      const scope =
        chosen !== null && chosen.length === 1 ? chosen[0] : undefined;
      if (
        scope === undefined ||
        !isFactoryScope(scope) ||
        !allowed.includes(scope)
      )
        return { kind: "invalid", code: "scope_invalid" };

      const code = newSecret("code");
      const grant: Grant = {
        id: newRowId(),
        workspaceId: membership.workspace.id,
        userId: input.userId,
        clientId: client.id,
        scopes: [scope],
        resource: config.resource,
        createdAt: at(),
        connectedAt: null,
        lastUsedAt: null,
        revokedAt: null,
      };
      const approved = await store.scoped(grant.workspaceId).approve({
        requestId: request.id,
        grant,
        code: {
          codeHash: hashSecret(code),
          grantId: grant.id,
          workspaceId: grant.workspaceId,
          clientId: client.id,
          redirectUri: request.redirectUri,
          codeChallenge: request.codeChallenge,
          expiresAt: after(CODE_TTL_MS),
          usedAt: null,
        },
        now: at(),
      });
      if (!approved) return { kind: "invalid", code: "request_not_found" };
      const target = new URL(request.redirectUri);
      target.searchParams.set("code", code);
      if (request.state !== null)
        target.searchParams.set("state", request.state);
      return {
        kind: "redirect",
        redirectTo: withIssuer(target, config.issuer).toString(),
      };
    },

    /** The token endpoint: `authorization_code` and `refresh_token`. */
    async exchange(params: URLSearchParams): Promise<ExchangeOutcome> {
      const grantType = single(params, "grant_type");
      if (grantType.kind !== "value")
        return tokenError("invalid_request", "grant_type is required once.");
      if (
        grantType.value !== "authorization_code" &&
        grantType.value !== "refresh_token"
      )
        return tokenError(
          "unsupported_grant_type",
          "Only authorization_code and refresh_token are supported.",
        );
      if (checkResource(params) === "invalid")
        return tokenError(
          "invalid_target",
          `The only resource is ${config.resource}.`,
        );
      const clientId = single(params, "client_id");
      if (clientId.kind !== "value")
        return tokenError(
          "invalid_request",
          "client_id is required once (public clients have no other authentication).",
        );

      if (grantType.value === "authorization_code") {
        const code = single(params, "code");
        const verifier = single(params, "code_verifier");
        const redirect = single(params, "redirect_uri");
        if (
          code.kind !== "value" ||
          verifier.kind !== "value" ||
          redirect.kind === "repeated"
        )
          return tokenError(
            "invalid_grant",
            "The code, the code verifier or the redirect URI is missing or repeated.",
          );
        const invalidGrant = tokenError(
          "invalid_grant",
          "The authorization code is invalid, expired or already used.",
        );
        if (!looksLikeSecret("code", code.value)) return invalidGrant;
        const hash = hashSecret(code.value);
        const found = await directory.findCode(hash);
        if (found === null) return invalidGrant;
        if (found.code.clientId !== clientId.value) return invalidGrant;
        if (found.code.usedAt !== null) {
          // The code was exchanged before: whoever has the tokens of that exchange may be the thief.
          await revokeGrant(found.grant);
          return invalidGrant;
        }
        if (found.code.expiresAt <= at() || found.grant.revokedAt !== null)
          return invalidGrant;
        if (
          redirect.kind === "value" &&
          redirect.value !== found.code.redirectUri
        )
          return invalidGrant;
        if (!(await directory.markCodeUsed(hash, at()))) {
          await revokeGrant(found.grant);
          return invalidGrant;
        }
        // The code is spent whatever the verifier says, so a guess cannot be repeated.
        if (!verifyPkce(verifier.value, found.code.codeChallenge))
          return invalidGrant;
        if ((await stillMember(found.grant)) === undefined) return invalidGrant;
        const body = await issueTokens(found.grant);
        await directory.markGrantConnected(found.grant.id, at());
        return { kind: "ok", body };
      }

      if (grantType.value === "refresh_token") {
        const presented = single(params, "refresh_token");
        const invalidGrant = tokenError(
          "invalid_grant",
          "The refresh token is invalid, expired or already used.",
        );
        if (
          presented.kind !== "value" ||
          !looksLikeSecret("refresh", presented.value)
        )
          return invalidGrant;
        const hash = hashSecret(presented.value);
        const found = await directory.findToken(hash);
        if (found === null || found.token.kind !== "refresh")
          return invalidGrant;
        if (
          found.grant.clientId !== clientId.value ||
          found.grant.revokedAt !== null
        )
          return invalidGrant;
        if (found.token.usedAt !== null) {
          if (
            now().getTime() - Date.parse(found.token.usedAt) >
            REFRESH_REUSE_GRACE_MS
          )
            await revokeGrant(found.grant);
          return invalidGrant;
        }
        if (found.token.expiresAt <= at()) return invalidGrant;
        if (
          Date.parse(found.grant.createdAt) + GRANT_MAX_AGE_MS <=
          now().getTime()
        )
          return invalidGrant;
        const scopeParam = single(params, "scope");
        if (scopeParam.kind === "repeated")
          return tokenError("invalid_scope", "scope is given more than once.");
        if (scopeParam.kind === "value") {
          const wanted = parseScopeList(scopeParam.value);
          if (
            wanted === null ||
            !wanted.every((scope) => found.grant.scopes.includes(scope))
          )
            return tokenError(
              "invalid_scope",
              "A refresh cannot widen what was approved.",
            );
        }
        if ((await stillMember(found.grant)) === undefined) return invalidGrant;
        if (!(await directory.markRefreshUsed(hash, at()))) return invalidGrant;
        const body = await issueTokens(found.grant);
        await directory.touchGrant(found.grant.id, at(), 0);
        return { kind: "ok", body };
      }

      return tokenError(
        "unsupported_grant_type",
        "Only authorization_code and refresh_token are supported.",
      );
    },

    /** RFC 7009: ends the grant the token belongs to. Never an error: an unknown token is already as good as revoked. */
    async revoke(token: string): Promise<void> {
      const kind = looksLikeSecret("access", token)
        ? "access"
        : looksLikeSecret("refresh", token)
          ? "refresh"
          : null;
      if (kind === null) return;
      const found = await directory.findToken(hashSecret(token));
      if (found === null) return;
      await revokeGrant(found.grant);
    },

    /** Who is calling the MCP endpoint with this bearer token, or why not. */
    async authenticate(bearer: string | null): Promise<AuthenticateOutcome> {
      if (bearer === null || bearer === "")
        return {
          kind: "error",
          error: "invalid_request",
          description: "No access token.",
        };
      const invalid = (description: string): AuthenticateOutcome => ({
        kind: "error",
        error: "invalid_token",
        description,
      });
      if (!looksLikeSecret("access", bearer))
        return invalid("The access token is not valid.");
      const found = await directory.findToken(hashSecret(bearer));
      if (found === null || found.token.kind !== "access")
        return invalid("The access token is not valid.");
      if (found.token.expiresAt <= at())
        return invalid("The access token has expired.");
      if (found.grant.revokedAt !== null)
        return invalid("The access was revoked.");
      // Audience binding (RFC 8707): the token was made for one resource and this is the only one that accepts it.
      if (normalizeResource(found.grant.resource) !== resourceKey)
        return invalid("The access token was not issued for this server.");
      const membership = await stillMember(found.grant);
      if (membership === undefined)
        return invalid("The access to the workspace ended.");
      await directory.touchGrant(
        found.grant.id,
        at(),
        LAST_USED_WRITE_INTERVAL_MS,
      );
      return {
        kind: "ok",
        principal: {
          grantId: found.grant.id,
          user: found.user,
          workspace: {
            id: membership.workspace.id,
            slug: membership.workspace.slug,
            name: membership.workspace.name,
          },
          role: membership.role,
          scopes: found.grant.scopes,
          client: found.client,
          connectedAt: found.grant.connectedAt,
          tokenExpiresAt: found.token.expiresAt,
        },
      };
    },
  };
}
