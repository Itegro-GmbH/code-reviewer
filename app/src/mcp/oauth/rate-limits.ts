// SPDX-License-Identifier: LicenseRef-Proprietary

// The limits of "Connect" of an MCP server (#1051): the shared counters of the database (src/db/repositories/rate-limits-repository.ts), never
// memory, so every app instance counts the same attempts. Two counters, each per person and for the instance, the same scheme as "Connect Jira"
// (src/jira/rate-limits.ts):
//
// - `start`: beginning a connection, which makes this server call an address an Owner or Admin entered (discovery, registration);
// - `callback`: what comes back from the authorization server, which makes a call to its token endpoint.
//
// The person's counter is the allowance of each person; the instance counter is only a backstop against a flood from many accounts.
import { secondsLeft } from "../../auth/sign-in-limit.ts";
import type { RateLimitsRepository } from "../../db/repositories/rate-limits-repository.ts";

export const MCP_OAUTH_WINDOW_MS = 10 * 60 * 1000;
export const MCP_OAUTH_USER_MAX = 20;
export const MCP_OAUTH_GLOBAL_MAX = 2000;

export const MCP_OAUTH_LIMITS = ["start", "callback"] as const;
export type McpOAuthLimit = (typeof MCP_OAUTH_LIMITS)[number];

export const mcpOAuthUserKey = (limit: McpOAuthLimit, userId: string): string =>
  `mcp-oauth-${limit}:user:${userId}`;
export const mcpOAuthGlobalKey = (limit: McpOAuthLimit): string =>
  `mcp-oauth-${limit}:all`;

export type LimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export async function hitMcpOAuthLimit(
  rateLimits: RateLimitsRepository,
  limit: McpOAuthLimit,
  userId: string,
  now: Date,
): Promise<LimitResult> {
  const denied = (hit: { windowStartedAt: Date }): LimitResult => ({
    allowed: false,
    retryAfterSeconds: secondsLeft(
      hit.windowStartedAt,
      MCP_OAUTH_WINDOW_MS,
      now,
    ),
  });
  const instance = await rateLimits.hit(
    mcpOAuthGlobalKey(limit),
    MCP_OAUTH_WINDOW_MS,
  );
  if (instance.count > MCP_OAUTH_GLOBAL_MAX) return denied(instance);
  const own = await rateLimits.hit(
    mcpOAuthUserKey(limit, userId),
    MCP_OAUTH_WINDOW_MS,
  );
  if (own.count > MCP_OAUTH_USER_MAX) {
    await rateLimits.refund(mcpOAuthGlobalKey(limit));
    return denied(own);
  }
  return { allowed: true };
}
