// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the four routes of the Implementer form (#755): `GET .../implementer/repositories`, `GET
// .../implementer/repositories/:repositoryId/branches`, `GET .../implementer/models` and `POST .../implementer/tasks`, with their
// collaborators passed in so the route files only wire the real ones and tests wire fakes.
//
// Order: the user first (nothing is read or looked at before the caller is known), then where the request comes from, then, for
// the start, its content type and its body, then the service. Every answer is `Cache-Control: no-store`. Every refusal is `{
// "error": <code> }` with a stable code from `errors.ts`; an unusable body adds `"issues": [{ "field", "code" }]`, a model that
// is not allowed its `reason`, a cost limit above the maximum `maximumCents`, a request id that made another task its `runId`. A new task answers 201 with `{ runId, sessionId }`,
// the same request again 200 with the same ids.
import { actorName, type SessionUser } from "../auth/access-policy.ts";
import { isCrossSite, isJsonRequest } from "../http/request-checks.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import { IMPLEMENTER_ERROR_STATUS, ImplementerError } from "./errors.ts";
import type { ImplementerService } from "./service.ts";

/** The instruction is at most 20,000 characters, which is at most 80 KB of UTF-8; the body limit is the one of the plan. */
export const IMPLEMENTER_REQUEST_MAX_BYTES = 64 * 1024;

export type ImplementerRouteDependencies = {
  /**
   * The signed in user, or a throw that ends the request (`requireUser()` redirects to the login page). Called first, on every
   * request.
   */
  requireUser: () => Promise<SessionUser>;
  service: ImplementerService;
};

export type ImplementerRouteHandlers = {
  repositories(request: Request): Promise<Response>;
  branches(request: Request, repositoryId: string): Promise<Response>;
  models(request: Request): Promise<Response>;
  start(request: Request): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(error: ImplementerError): Response {
  return Response.json(
    {
      error: error.code,
      ...(error.issues.length > 0 ? { issues: error.issues } : {}),
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      ...(error.maximumCents === undefined
        ? {}
        : { maximumCents: error.maximumCents }),
      ...(error.runId === undefined ? {} : { runId: error.runId }),
    },
    { status: IMPLEMENTER_ERROR_STATUS[error.code], headers: NO_STORE },
  );
}

function refuseCrossSite(request: Request): void {
  if (isCrossSite(request))
    throw new ImplementerError(
      "IMPLEMENTER_CROSS_SITE_REQUEST",
      "The request does not come from this site.",
    );
}

async function readBody(request: Request): Promise<unknown> {
  if (!isJsonRequest(request))
    throw new ImplementerError(
      "IMPLEMENTER_CONTENT_TYPE_UNSUPPORTED",
      "The body must be application/json.",
    );
  const body = await readLimitedBody(request, IMPLEMENTER_REQUEST_MAX_BYTES);
  if (!body.ok)
    throw new ImplementerError(
      "IMPLEMENTER_BODY_TOO_LARGE",
      "The request body is too large.",
    );
  try {
    return JSON.parse(body.text);
  } catch {
    throw new ImplementerError(
      "IMPLEMENTER_REQUEST_INVALID",
      "The body is not valid JSON.",
    );
  }
}

export function createImplementerRouteHandlers({
  requireUser,
  service,
}: ImplementerRouteDependencies): ImplementerRouteHandlers {
  /** The same wrapper for every route: the user, the origin, the work, and a refusal of this module as its answer. */
  async function answer(
    request: Request,
    work: (user: SessionUser) => Promise<Response>,
  ): Promise<Response> {
    const user = await requireUser();
    try {
      refuseCrossSite(request);
      return await work(user);
    } catch (error) {
      if (error instanceof ImplementerError) return refusal(error);
      throw error;
    }
  }

  return {
    repositories: (request) =>
      answer(request, async () =>
        Response.json(await service.listRepositories(), { headers: NO_STORE }),
      ),
    branches: (request, repositoryId) =>
      answer(request, async () =>
        Response.json(await service.listBranches(repositoryId), {
          headers: NO_STORE,
        }),
      ),
    models: (request) =>
      answer(request, async () =>
        Response.json(await service.listModels(), { headers: NO_STORE }),
      ),
    start: (request) =>
      answer(request, async (user) => {
        const started = await service.startTask(
          // The login that is recorded as the one who started the task: the GitHub login, or the email of an account without
          // GitHub. The creator is the account itself.
          { id: user.id, githubLogin: actorName(user) },
          await readBody(request),
        );
        return Response.json(
          { runId: started.runId, sessionId: started.sessionId },
          { status: started.created ? 201 : 200, headers: NO_STORE },
        );
      }),
  };
}
