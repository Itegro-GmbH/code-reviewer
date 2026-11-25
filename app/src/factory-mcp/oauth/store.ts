// SPDX-License-Identifier: LicenseRef-Proprietary

// What the OAuth server of the factory MCP (epic #1143, issue #1144) needs from storage. The types live in the database layer
// (`db/factory-oauth-types.ts`, like the workspace roles) so that layer imports nothing of the factory MCP; the service
// (`service.ts`) works against them only; the Kysely repositories implement them and tests use `memory-store.ts`.
//
// Two parts, as the repositories are (src/db/README.md, "Workspace scoping"): `OAuthDirectory` is instance level (clients, pending
// authorization requests and the lookups by the hash of a code or a token, where the workspace is the ANSWER); `ScopedGrants` is one
// workspace (making a grant, listing the connected apps, revoking one).
export type {
  OAuthClient,
  AuthorizationRequest,
  Grant,
  CodeRecord,
  TokenKind,
  TokenRecord,
  TokenLookup,
  CodeLookup,
  GrantView,
  OAuthDirectory,
  ScopedGrants,
  OAuthStore,
} from "../../db/factory-oauth-types.ts";
