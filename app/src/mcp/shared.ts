// SPDX-License-Identifier: LicenseRef-Proprietary

// The MCP registry on the running server (#1050): the real database, the master key from the environment, the test flag, and the guarded
// fetch the connection test uses. Server code only.
import "server-only";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { createMcpServersRepository } from "../db/repositories/mcp-servers-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createGuardedFetch } from "../dispatch/guarded-fetch.ts";
import { mcpTestEndpointsAllowed } from "./config.ts";
import { createMcpRouteHandlers, type McpRouteHandlers } from "./http.ts";
import { createMcpService, type McpService } from "./service.ts";

function appSecret(): string {
  const resolved = resolveAppSecret(process.env);
  // The server does not start without it (src/auth/startup.ts); this is the second line.
  if (!resolved.ok) throw new Error(resolved.problem);
  return resolved.secret;
}

/** One guarded fetch for each setting of the flag, kept for the life of the process so its connections are reused. */
const guardedFetches = new Map<
  boolean,
  ReturnType<typeof createGuardedFetch>
>();

function guardedFetch(allowLoopback: boolean) {
  let guarded = guardedFetches.get(allowLoopback);
  if (guarded === undefined) {
    guarded = createGuardedFetch({ allowLoopback });
    guardedFetches.set(allowLoopback, guarded);
  }
  return guarded;
}

/** The registry of one workspace. */
export function mcpServiceFor(workspaceId: string): McpService {
  const db = getDatabase();
  const allowTestEndpoints = mcpTestEndpointsAllowed(process.env);
  return createMcpService({
    workspaceId,
    repository: createMcpServersRepository(db, workspaceId),
    rateLimits: createRateLimitsRepository(db),
    appSecret: appSecret(),
    fetch: guardedFetch(allowTestEndpoints),
    allowTestEndpoints,
  });
}

export function getMcpRouteHandlers(): McpRouteHandlers {
  return createMcpRouteHandlers({ serviceFor: mcpServiceFor });
}
