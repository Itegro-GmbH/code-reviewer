// SPDX-License-Identifier: LicenseRef-Proprietary

// The OAuth connection of MCP servers on the running server (#1051): the real database, the master key and the public address from the
// environment, the guarded fetch, and the route handlers. Server code only.
import "server-only";
import { loadAuthConfig } from "../../auth/config.ts";
import { lookupSessionId } from "../../auth/session.ts";
import { resolveAppSecret } from "../../crypto/app-secret.ts";
import { createRateLimitsRepository } from "../../db/repositories/rate-limits-repository.ts";
import { createWorkspacesRepository } from "../../db/repositories/workspaces-repository.ts";
import { getDatabase } from "../../db/startup.ts";
import { sessionOfRequest } from "../../github-signin/shared.ts";
import { getProductIdentity } from "../../product-identity/current.ts";
import { createSignedStates } from "../../signed-state/state.ts";
import { mcpTestEndpointsAllowed } from "../config.ts";
import { guardedMcpFetch } from "../shared.ts";
import {
  createMcpOAuthRouteHandlers,
  type McpOAuthRouteHandlers,
} from "./http.ts";
import { createMcpOAuthService, type McpOAuthService } from "./service.ts";

function appSecret(): string {
  const resolved = resolveAppSecret(process.env);
  // The server does not start without it (src/auth/startup.ts); this is the second line.
  if (!resolved.ok) throw new Error(resolved.problem);
  return resolved.secret;
}

export function getMcpOAuthService(): McpOAuthService {
  const db = getDatabase();
  const allowTestEndpoints = mcpTestEndpointsAllowed(process.env);
  const secret = appSecret();
  return createMcpOAuthService({
    db,
    signedStates: createSignedStates({ db, appSecret: secret }),
    rateLimits: createRateLimitsRepository(db),
    http: { fetch: guardedMcpFetch(allowTestEndpoints), allowTestEndpoints },
    publicUrl: loadAuthConfig(process.env).baseUrl,
    appSecret: secret,
    clientName: getProductIdentity().name,
  });
}

export function getMcpOAuthRouteHandlers(): McpOAuthRouteHandlers {
  const db = getDatabase();
  return createMcpOAuthRouteHandlers({
    service: getMcpOAuthService(),
    sessionId: lookupSessionId,
    session: sessionOfRequest,
    workspaceSlug: async (workspaceId) =>
      (await createWorkspacesRepository(db).get(workspaceId))?.slug ?? null,
  });
}
