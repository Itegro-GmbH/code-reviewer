// SPDX-License-Identifier: LicenseRef-Proprietary

// Which capability each route of the app belongs to (#731): the one table the proxy gate (gate.ts), the tests and
// the navigation read. A route is `core` (every deployment has it: sign-in, accounts, workspaces, members, the
// general admin portal, the health check) or belongs to one capability, and then it does not exist in a deployment
// without that capability. The patterns are the routes of `src/app` (`[workspace]` stands for one segment); a
// pattern matches the path and everything below it, `exact` only the path itself, and the longest pattern wins, so
// `/w/[workspace]/settings/billing` can belong to billing inside the core `/w/[workspace]/settings`.
// There is one entry per page, route handler and metadata file of `src/app`, no blanket prefix: `routes.test.ts`
// fails for a route file without its own entry (and for an entry without a file), so a route added anywhere has to be
// classified, with its class chosen, before it can be merged.
import { normalizePath } from "./path.ts";
import type { Capability, CapabilitySet } from "./capability.ts";

export type RouteClass = "core" | Capability;

type RouteEntry = {
  route: string;
  class: RouteClass;
  /** Only this path, not what is below it. */
  exact?: true;
};

export const ROUTE_CLASSES: readonly RouteEntry[] = [
  // Core: the way in, accounts, workspaces, the general admin portal, the health check and the app's icons.
  { route: "/", class: "core", exact: true },
  { route: "/account", class: "core" },
  { route: "/api/account/github/link", class: "core" },
  { route: "/api/auth/[...all]", class: "core" },
  { route: "/api/health", class: "core" },
  { route: "/api/instance-portal/approvals/[id]", class: "core" },
  { route: "/api/instance-portal/catalog-fetch", class: "core" },
  { route: "/api/instance-portal/catalog-models", class: "core" },
  { route: "/api/instance-portal/catalog-models/enablement", class: "core" },
  {
    route: "/api/instance-portal/catalog-models/enablement/reset",
    class: "core",
  },
  { route: "/api/instance-portal/catalog-models/price/confirm", class: "core" },
  { route: "/api/instance-portal/catalog-models/price/correct", class: "core" },
  {
    route: "/api/instance-portal/catalog-providers/url/confirm",
    class: "core",
  },
  { route: "/api/instance-portal/github", class: "core" },
  { route: "/api/instance-portal/github/check", class: "core" },
  { route: "/api/instance-portal/github/manifest", class: "core" },
  { route: "/api/instance-portal/github/manifest/callback", class: "core" },
  { route: "/api/instance-portal/integrations/sync", class: "core" },
  { route: "/api/instance-portal/llm-keys/[provider]/test", class: "core" },
  { route: "/api/instance-portal/mail/test", class: "core" },
  { route: "/api/instance-portal/model-catalog", class: "core" },
  { route: "/api/instance-portal/model-catalog/[id]", class: "core" },
  { route: "/api/instance-portal/model-catalog/[id]/release", class: "core" },
  { route: "/api/instance-portal/model-catalog/[id]/retire", class: "core" },
  { route: "/api/instance-portal/model-catalog/check", class: "core" },
  { route: "/api/instance-portal/model-catalog/defaults", class: "core" },
  { route: "/api/instance-portal/model-catalog/order", class: "core" },
  { route: "/api/instance-portal/settings", class: "core" },
  { route: "/api/internal/dispatch-sweep", class: "core" },
  { route: "/api/invitations/accept", class: "core" },
  { route: "/api/operator/v1/[...path]", class: "core" },
  { route: "/api/operator/v1/entitlements/default", class: "core" },
  { route: "/api/operator/v1/handoff/redeem", class: "core" },
  { route: "/api/operator/v1/plan-management", class: "core" },
  { route: "/api/operator/v1/usage", class: "core" },
  { route: "/api/operator/v1/usage/unknown-cost", class: "core" },
  { route: "/api/operator/v1/workspaces", class: "core" },
  { route: "/api/operator/v1/workspaces/[id]/entitlements", class: "core" },
  { route: "/api/operator/v1/workspaces/[id]/usage", class: "core" },
  { route: "/api/operator/v1/workspaces/[id]/usage/summary", class: "core" },
  { route: "/api/password-reset", class: "core" },
  { route: "/api/password-reset/request", class: "core" },
  { route: "/api/setup/code", class: "core" },
  { route: "/api/setup/complete", class: "core" },
  { route: "/api/sign-up", class: "core" },
  { route: "/api/verify-email", class: "core" },
  { route: "/api/verify-email/resend", class: "core" },
  { route: "/api/w/[workspace]", class: "core" },
  { route: "/api/w/[workspace]/github/connect", class: "core" },
  { route: "/api/w/[workspace]/github/installations", class: "core" },
  { route: "/api/w/[workspace]/github/installations/choose", class: "core" },
  { route: "/api/w/[workspace]/integrations/[integrationId]", class: "core" },
  { route: "/api/w/[workspace]/integrations/sync", class: "core" },
  { route: "/api/w/[workspace]/invitations", class: "core" },
  { route: "/api/w/[workspace]/invitations/[invitationId]", class: "core" },
  {
    route: "/api/w/[workspace]/invitations/[invitationId]/resend",
    class: "core",
  },
  { route: "/api/w/[workspace]/llm-catalog/[provider]/models", class: "core" },
  { route: "/api/w/[workspace]/llm-key", class: "core" },
  { route: "/api/w/[workspace]/llm-key/test", class: "core" },
  { route: "/api/w/[workspace]/llm-keys/[provider]", class: "core" },
  { route: "/api/w/[workspace]/llm-keys/[provider]/test", class: "core" },
  { route: "/api/w/[workspace]/members/[userId]", class: "core" },
  { route: "/api/w/[workspace]/plan", class: "core" },
  { route: "/api/w/[workspace]/plan-handoff", class: "core" },
  { route: "/api/workspaces", class: "core" },
  { route: "/apple-icon.png", class: "core" },
  { route: "/favicon.ico", class: "core" },
  { route: "/forgot-password", class: "core" },
  { route: "/github/connected", class: "core" },
  { route: "/github/result", class: "core" },
  { route: "/icon.svg", class: "core" },
  { route: "/instance-portal", class: "core" },
  { route: "/instance-portal/approvals", class: "core" },
  { route: "/instance-portal/catalog", class: "core" },
  { route: "/instance-portal/integrations", class: "core" },
  { route: "/instance-portal/integrations/github", class: "core" },
  { route: "/instance-portal/limits", class: "core" },
  { route: "/instance-portal/llm", class: "core" },
  { route: "/instance-portal/mail", class: "core" },
  { route: "/instance-portal/setup", class: "core" },
  { route: "/instance-portal/setup/instance", class: "core" },
  { route: "/instance-portal/setup/sign-in", class: "core" },
  { route: "/instance-portal/setup/sign-up", class: "core" },
  { route: "/invitation", class: "core" },
  { route: "/invitations", class: "core" },
  { route: "/login", class: "core" },
  { route: "/no-access", class: "core" },
  { route: "/reset-password", class: "core" },
  { route: "/settings", class: "core" },
  { route: "/setup", class: "core" },
  { route: "/sign-up", class: "core" },
  { route: "/verify-email", class: "core" },
  { route: "/w/[workspace]", class: "core" },
  { route: "/w/[workspace]/connections", class: "core" },
  { route: "/w/[workspace]/members", class: "core" },
  { route: "/w/[workspace]/settings", class: "core" },
  { route: "/w/[workspace]/settings/advanced", class: "core" },
  { route: "/w/[workspace]/settings/llm", class: "core" },
  { route: "/w/[workspace]/settings/plan", class: "core" },
  { route: "/workspaces/new", class: "core" },

  // Review: pull requests, projects, runs and everything that feeds or serves a job.
  { route: "/api/internal/repository-sync", class: "review" },
  { route: "/api/runners/v1/claim", class: "review" },
  { route: "/api/runners/v1/jobs/[id]", class: "review" },
  { route: "/api/runners/v1/jobs/[id]/complete", class: "review" },
  { route: "/api/runners/v1/jobs/[id]/heartbeat", class: "review" },
  { route: "/api/runners/v1/jobs/[id]/release", class: "review" },
  { route: "/api/runners/v1/jobs/[id]/vm", class: "review" },
  { route: "/api/runners/v1/version", class: "review" },
  { route: "/api/webhooks/github-app", class: "review" },
  {
    route: "/api/w/[workspace]/repositories/[repositoryId]/project",
    class: "review",
  },
  {
    route: "/api/w/[workspace]/repositories/[repositoryId]/project/settings",
    class: "review",
  },
  {
    route: "/api/w/[workspace]/repositories/[repositoryId]/pull-requests",
    class: "review",
  },
  {
    route: "/api/w/[workspace]/repositories/[repositoryId]/reviews",
    class: "review",
  },
  { route: "/api/w/[workspace]/review-settings", class: "review" },
  { route: "/api/w/[workspace]/runs", class: "review" },
  { route: "/api/w/[workspace]/runs/[id]", class: "review" },
  { route: "/instance-portal/runs", class: "review" },
  { route: "/instance-portal/runs/[id]", class: "review" },
  { route: "/projects/[[...rest]]", class: "review" },
  { route: "/runs/[[...rest]]", class: "review" },
  { route: "/w/[workspace]/projects", class: "review" },
  { route: "/w/[workspace]/projects/[repositoryId]", class: "review" },
  { route: "/w/[workspace]/runs", class: "review" },
  { route: "/w/[workspace]/runs/[id]", class: "review" },
  { route: "/w/[workspace]/settings/review-defaults", class: "review" },

  // Dynamic review: the Worker API of the agent sessions (a Dynamic job is claimed by a Runner, which reports through it).
  { route: "/api/workers/v1/jobs/[id]", class: "dynamic-review" },
  { route: "/api/workers/v1/jobs/[id]/heartbeat", class: "dynamic-review" },
  { route: "/api/workers/v1/jobs/[id]/result", class: "dynamic-review" },

  // Implementer: the routes behind the form that sends a task to the agent (#755; factory only), and the page that uses them (#756).
  { route: "/api/w/[workspace]/implementer/models", class: "implementer" },
  {
    route: "/api/w/[workspace]/implementer/repositories",
    class: "implementer",
  },
  {
    route:
      "/api/w/[workspace]/implementer/repositories/[repositoryId]/branches",
    class: "implementer",
  },
  { route: "/api/w/[workspace]/implementer/tasks", class: "implementer" },
  // The page of the form (#756).
  { route: "/w/[workspace]/implementer", class: "implementer" },

  // Billing: payments, balance, rates and everything that only exists while a workspace pays.
  { route: "/api/billing/webhook", class: "billing" },
  { route: "/api/instance-portal/billing", class: "billing" },
  { route: "/api/instance-portal/billing/check", class: "billing" },
  { route: "/api/instance-portal/billing/reviews", class: "billing" },
  { route: "/api/instance-portal/billing/reviews/check", class: "billing" },
  { route: "/api/instance-portal/billing/reviews/resolve", class: "billing" },
  { route: "/api/instance-portal/billing/webhook-endpoint", class: "billing" },
  { route: "/api/instance-portal/billing/workspaces", class: "billing" },
  { route: "/api/instance-portal/billing/workspaces/[id]", class: "billing" },
  {
    route: "/api/instance-portal/billing/workspaces/[id]/credit",
    class: "billing",
  },
  { route: "/api/w/[workspace]/billing/invoices", class: "billing" },
  { route: "/api/w/[workspace]/billing/journal", class: "billing" },
  { route: "/api/w/[workspace]/billing/monthly-limit", class: "billing" },
  { route: "/api/w/[workspace]/billing/profile", class: "billing" },
  { route: "/api/w/[workspace]/billing/top-ups", class: "billing" },
  { route: "/api/w/[workspace]/billing/top-ups/[id]/check", class: "billing" },
  { route: "/api/w/[workspace]/llm-key-mode", class: "billing" },
  { route: "/instance-portal/billing", class: "billing" },
  { route: "/instance-portal/billing/reviews", class: "billing" },
  { route: "/w/[workspace]/settings/billing", class: "billing" },
];

const isDynamicSegment = (segment: string) => segment.startsWith("[");

const isCatchAll = (segment: string) => /^\[{1,2}\.\.\./.test(segment);

/** The segments of a route; a trailing catch-all (`[...all]`, `[[...rest]]`) is dropped, as the path below covers it anyway. */
function segmentsOf(route: string): string[] {
  const segments = route.split("/").filter((segment) => segment !== "");
  const last = segments.at(-1);
  if (last !== undefined && isCatchAll(last)) segments.pop();
  return segments;
}

/** Whether `entry` covers the route or path given as segments. A dynamic segment of a pattern covers any one segment. */
function covers(entry: RouteEntry, segments: readonly string[]): boolean {
  const pattern = segmentsOf(entry.route);
  if (
    entry.exact === true
      ? segments.length !== pattern.length
      : segments.length < pattern.length
  )
    return false;
  return pattern.every((part, index) => {
    const segment = segments[index];
    if (segment === undefined) return false;
    return isDynamicSegment(part) || part === segment;
  });
}

function specificity(entry: RouteEntry): number {
  const pattern = segmentsOf(entry.route);
  return (
    pattern.length * 2 + pattern.filter((p) => !isDynamicSegment(p)).length
  );
}

/**
 * The class of a route of `src/app` (a file's route, `/w/[workspace]/projects/[repositoryId]`) or of a request path
 * (`/w/acme/projects/42`), or undefined when no pattern covers it.
 */
export function classOfRoute(route: string): RouteClass | undefined {
  const segments = segmentsOf(route);
  let best: RouteEntry | undefined;
  for (const entry of ROUTE_CLASSES) {
    if (!covers(entry, segments)) continue;
    if (best === undefined || specificity(entry) > specificity(best))
      best = entry;
  }
  return best?.class;
}

/**
 * The capability a request path needs, or undefined for a core path and for one the table does not know (it is no route
 * of the app, so it is missing anyway). The admin portal's addresses (`/admin/...`, `/api/admin/...`) are read as the
 * files that serve them. A path that cannot be decoded has no page either.
 */
/**
 * The files that serve an admin address (`/admin/billing` is `/instance-portal/billing`). The same two roots as
 * `portalRewriteTarget` in src/admin/paths.ts (a test keeps them equal); repeated here so that the capability table
 * imports nothing from the admin portal, which imports the capability set.
 */
const ADMIN_SERVED_BY = [
  ["/admin", "/instance-portal"],
  ["/api/admin", "/api/instance-portal"],
] as const;

function servedPath(path: string): string {
  for (const [root, target] of ADMIN_SERVED_BY)
    if (path === root || path.startsWith(`${root}/`))
      return `${target}${path.slice(root.length)}`;
  return path;
}

export function capabilityOfPath(pathname: string): Capability | undefined {
  const path = normalizePath(pathname);
  if (path === null) return undefined;
  const result = classOfRoute(servedPath(path));
  return result === undefined || result === "core" ? undefined : result;
}

/** Whether a request path belongs to a capability this deployment does not have: it answers as a path that is not there. */
export function isAbsentPath(
  pathname: string,
  capabilities: CapabilitySet,
): boolean {
  const needed = capabilityOfPath(pathname);
  return needed !== undefined && !capabilities.has(needed);
}
