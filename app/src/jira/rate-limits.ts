// SPDX-License-Identifier: LicenseRef-Proprietary

// The limits of "Connect Jira" (#1037): the shared counters of the database (src/db/repositories/rate-limits-repository.ts), never
// memory, so every app instance counts the same attempts. Two counters, each per person and for the instance, the same scheme as the
// binding of GitHub installations (src/installation-binding/rate-limits.ts):
//
// - `start`: beginning a connection, which makes a signed state and an address at Atlassian;
// - `callback`: what comes back from Atlassian, which makes calls to Atlassian with the app's secret.
//
// The person's counter is the allowance of each person; the instance counter is only a backstop against a flood from many accounts.
import { secondsLeft } from "../auth/sign-in-limit.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";

export const JIRA_WINDOW_MS = 10 * 60 * 1000;
export const JIRA_USER_MAX = 10;
export const JIRA_GLOBAL_MAX = 2000;

export const JIRA_LIMITS = ["start", "callback"] as const;
export type JiraLimit = (typeof JIRA_LIMITS)[number];

export const jiraUserKey = (limit: JiraLimit, userId: string): string =>
  `jira-connect-${limit}:user:${userId}`;
export const jiraGlobalKey = (limit: JiraLimit): string =>
  `jira-connect-${limit}:all`;

export type LimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export async function hitJiraLimit(
  rateLimits: RateLimitsRepository,
  limit: JiraLimit,
  userId: string,
  now: Date,
): Promise<LimitResult> {
  const denied = (hit: { windowStartedAt: Date }): LimitResult => ({
    allowed: false,
    retryAfterSeconds: secondsLeft(hit.windowStartedAt, JIRA_WINDOW_MS, now),
  });
  const instance = await rateLimits.hit(jiraGlobalKey(limit), JIRA_WINDOW_MS);
  if (instance.count > JIRA_GLOBAL_MAX) return denied(instance);
  const own = await rateLimits.hit(jiraUserKey(limit, userId), JIRA_WINDOW_MS);
  if (own.count > JIRA_USER_MAX) {
    await rateLimits.refund(jiraGlobalKey(limit));
    return denied(own);
  }
  return { allowed: true };
}
