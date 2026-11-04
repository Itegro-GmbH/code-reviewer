// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind `GET /api/runs` (the list, with its filter) and `GET /api/runs/:id` (one run):
// what the pages ask for again and again while a run is waiting or running. Their collaborators are
// passed in so the route files only wire the real ones and tests wire fakes.
//
// Order: the user first (nothing is read before the caller is known), then the filter, then the
// service. Every refusal is `{ "error": <code> }` with a stable code; every answer is `no-store`.
import type { SessionUser } from "../auth/access-policy.ts";
import { parseRunsFilter, type RunsService } from "./runs-service.ts";
import { parseStepsQuery, type RunStepsService } from "./steps-service.ts";

export const RUNS_ERROR_CODES = [
  "RUNS_FILTER_INVALID",
  "RUN_NOT_FOUND",
  "STEPS_QUERY_INVALID",
] as const;
export type RunsErrorCode = (typeof RUNS_ERROR_CODES)[number];

const STATUS: Record<RunsErrorCode, number> = {
  RUNS_FILTER_INVALID: 400,
  RUN_NOT_FOUND: 404,
  STEPS_QUERY_INVALID: 400,
};

export type RunsRouteDependencies = {
  /** The signed in user, or a throw that ends the request. Called first, on every request. */
  requireUser: () => Promise<SessionUser>;
  service: RunsService;
};

export type RunStepsRouteDependencies = {
  requireUser: () => Promise<SessionUser>;
  service: RunStepsService;
};

export type RunsRouteHandlers = {
  list(request: Request): Promise<Response>;
  detail(request: Request, id: string): Promise<Response>;
};

export type RunStepsRouteHandlers = {
  steps(request: Request, id: string): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(code: RunsErrorCode): Response {
  return Response.json(
    { error: code },
    { status: STATUS[code], headers: NO_STORE },
  );
}

export function createRunsRouteHandlers({
  requireUser,
  service,
}: RunsRouteDependencies): RunsRouteHandlers {
  return {
    async list(request) {
      await requireUser();
      const params = new URL(request.url).searchParams;
      const filter = parseRunsFilter({
        repositoryId: params.get("repository") ?? undefined,
        status: params.get("status") ?? undefined,
      });
      if (!filter.ok) return refusal("RUNS_FILTER_INVALID");
      return Response.json(await service.list(filter.filter), {
        headers: NO_STORE,
      });
    },

    async detail(_request, id) {
      await requireUser();
      const snapshot = await service.get(id);
      if (snapshot === undefined) return refusal("RUN_NOT_FOUND");
      return Response.json(snapshot, { headers: NO_STORE });
    },
  };
}

/**
 * The handler behind `GET /api/w/:workspace/runs/:id/steps?after=&limit=` (#745, live view): the parts of the agent's work that
 * changed after the cursor. Same order as the others: the user, then the query, then the service. A run that is not a run of the
 * Implementer of the workspace answers 404 `RUN_NOT_FOUND`.
 */
export function createRunStepsRouteHandlers({
  requireUser,
  service,
}: RunStepsRouteDependencies): RunStepsRouteHandlers {
  return {
    async steps(request, id) {
      await requireUser();
      const params = new URL(request.url).searchParams;
      const query = parseStepsQuery({
        after: params.get("after"),
        limit: params.get("limit"),
      });
      if (!query.ok) return refusal("STEPS_QUERY_INVALID");
      const snapshot = await service.list(id, query.after, query.limit);
      if (snapshot === undefined) return refusal("RUN_NOT_FOUND");
      return Response.json(snapshot, { headers: NO_STORE });
    },
  };
}
