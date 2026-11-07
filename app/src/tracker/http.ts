// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind `GET /api/w/:workspace/repositories/:repositoryId/issues` (the tickets of a project's repository, enriched with the
// run that is going on and the money spent) and `POST /api/w/:workspace/repositories/:repositoryId/issues/sync` (the full sync, "Resync"),
// with their collaborators passed in so the route files only wire the real ones and tests wire fakes (#923).
//
// Order: the user first (nothing is read before the caller is known), then, for the sync, where the request comes from, then the
// service. Every refusal is `{ "error": <code> }` with a stable code from `errors.ts`; a query that is not usable names the parameter
// in `issues: [{ "path", "code", "message", "available" }]`, where `available` lists the values that would have been accepted. Every
// answer is `Cache-Control: no-store`.
import type { SessionUser } from "../auth/access-policy.ts";
import { isCrossSite } from "../http/request-checks.ts";
import {
  TRACKER_ERROR_STATUS,
  TrackerError,
  type TrackerErrorCode,
} from "./errors.ts";
import type { TicketQuery, TrackerService } from "./service.ts";

export const TICKET_STATES = ["open", "closed", "all"] as const;
export const TICKET_LIST_DEFAULT_LIMIT = 100;
export const TICKET_LIST_MAX_LIMIT = 200;
const MAX_OFFSET = 100_000;
/** How long one call of the sync may read before it answers `partial` (the platform's limit for a function is longer; this leaves room). */
export const SYNC_BUDGET_MS = 20_000;

export type TrackerRouteDependencies = {
  /** The signed in user, or a throw that ends the request. Called first, on every request. */
  requireUser: () => Promise<SessionUser>;
  service: TrackerService;
  now?: () => number;
};

export type TrackerRouteHandlers = {
  list(request: Request, repositoryId: string): Promise<Response>;
  sync(request: Request, repositoryId: string): Promise<Response>;
};

/** One query parameter that cannot be used. `available` is set for a value out of a closed set. */
export type TrackerRequestIssue = {
  path: string;
  code: "invalid" | "out_of_range";
  message: string;
  available?: readonly string[];
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(
  code: TrackerErrorCode,
  issues: readonly TrackerRequestIssue[] = [],
): Response {
  return Response.json(
    { error: code, ...(issues.length > 0 ? { issues } : {}) },
    { status: TRACKER_ERROR_STATUS[code], headers: NO_STORE },
  );
}

function whole(
  text: string | null,
  name: string,
  fallback: number,
  min: number,
  max: number,
  issues: TrackerRequestIssue[],
): number {
  if (text === null) return fallback;
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) {
    issues.push({
      path: name,
      code: "invalid",
      message: `${name} must be a whole number.`,
    });
    return fallback;
  }
  if (value < min || value > max) {
    issues.push({
      path: name,
      code: "out_of_range",
      message: `${name} must be between ${min} and ${max}.`,
    });
    return fallback;
  }
  return value;
}

/** The query of the list as the service takes it, or the parameters that cannot be used. */
export function readTicketQuery(
  url: URL,
):
  | { ok: true; value: TicketQuery }
  | { ok: false; issues: TrackerRequestIssue[] } {
  const issues: TrackerRequestIssue[] = [];
  const stateText = url.searchParams.get("state");
  let state: TicketQuery["state"] = "open";
  if (stateText !== null) {
    if ((TICKET_STATES as readonly string[]).includes(stateText))
      state = stateText as TicketQuery["state"];
    else
      issues.push({
        path: "state",
        code: "invalid",
        message: `state "${stateText.slice(0, 40)}" is not one of ${TICKET_STATES.join(", ")}.`,
        available: TICKET_STATES,
      });
  }
  const limit = whole(
    url.searchParams.get("limit"),
    "limit",
    TICKET_LIST_DEFAULT_LIMIT,
    1,
    TICKET_LIST_MAX_LIMIT,
    issues,
  );
  const offset = whole(
    url.searchParams.get("offset"),
    "offset",
    0,
    0,
    MAX_OFFSET,
    issues,
  );
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: { state, limit, offset } };
}

export function createTrackerRouteHandlers({
  requireUser,
  service,
  now = () => Date.now(),
}: TrackerRouteDependencies): TrackerRouteHandlers {
  return {
    async list(request, repositoryId) {
      await requireUser();
      const query = readTicketQuery(new URL(request.url));
      if (!query.ok) return refusal("TRACKER_REQUEST_INVALID", query.issues);
      try {
        return Response.json(
          await service.listIssues(repositoryId, query.value),
          {
            headers: NO_STORE,
          },
        );
      } catch (error) {
        if (error instanceof TrackerError) return refusal(error.code);
        throw error;
      }
    },

    async sync(request, repositoryId) {
      await requireUser();
      // A change of state: never from another site.
      if (isCrossSite(request)) return refusal("TRACKER_CROSS_SITE_REQUEST");
      try {
        const progress = await service.sync(repositoryId, {
          deadline: now() + SYNC_BUDGET_MS,
        });
        // 200 when the cache is complete, 202 when the call stopped at its budget and asking again continues.
        return Response.json(progress, {
          status: progress.status === "done" ? 200 : 202,
          headers: NO_STORE,
        });
      } catch (error) {
        if (error instanceof TrackerError) return refusal(error.code);
        throw error;
      }
    },
  };
}
