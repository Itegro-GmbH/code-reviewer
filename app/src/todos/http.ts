// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind `GET /api/w/:workspace/todos`, `GET /api/w/:workspace/projects/:projectId/todos` and
// `POST /api/w/:workspace/todos/reviews` (#924), with their collaborators passed in so the route files only wire the real ones and tests
// wire fakes. Order, as for the other factory routes: the user first, then (for a change) where the request comes from, its content type
// and size, then the service. Every answer is `Cache-Control: no-store`; a refusal is `{ "error": <code>, "message": ... }` with a stable
// code from `errors.ts`, and a body that cannot be used names every problem in `issues: [{ path, code, message, available }]`.
import type { SessionUser } from "../auth/access-policy.ts";
import { isCrossSite, isJsonRequest } from "../http/request-checks.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import { TODOS_ERROR_STATUS, TodosError } from "./errors.ts";
import { readReviewInput, type ReviewActions } from "./review.ts";
import type { TodosService } from "./service.ts";

/** A review body is a few short fields. */
export const REVIEW_BODY_MAX_BYTES = 32 * 1024;

export type TodosRouteDependencies = {
  /** The signed in user, or a throw that ends the request. Called first, on every request. */
  requireUser: () => Promise<SessionUser>;
  service: TodosService;
  reviews: ReviewActions;
};

export type TodosRouteHandlers = {
  /** 200 `{ projectId: null, questions, reviews, done }` for all projects of the workspace. */
  list(request: Request): Promise<Response>;
  /** The same for one project; 404 `TODOS_PROJECT_NOT_FOUND`. */
  listForProject(request: Request, projectId: string): Promise<Response>;
  /**
   * `POST` `{ repositoryId, number, decision: "approve" | "request_changes", comment? }`: 200 `{ outcome: "submitted" | "already_there",
   * reviewId }` or `{ outcome: "commented", url }`; 400 `TODOS_REQUEST_INVALID`; 404 `TODOS_REVIEW_NOT_REQUESTED` (no review is asked of this person for it: the same answer for a pull request that does not exist).
   */
  review(request: Request): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(error: TodosError): Response {
  return Response.json(
    {
      error: error.code,
      message: error.message,
      ...(error.issues.length > 0 ? { issues: error.issues } : {}),
    },
    { status: TODOS_ERROR_STATUS[error.code], headers: NO_STORE },
  );
}

async function readBody(request: Request): Promise<unknown> {
  if (!isJsonRequest(request))
    throw new TodosError(
      "TODOS_CONTENT_TYPE_UNSUPPORTED",
      "The body must be application/json.",
    );
  const body = await readLimitedBody(request, REVIEW_BODY_MAX_BYTES);
  if (!body.ok)
    throw new TodosError(
      "TODOS_BODY_TOO_LARGE",
      "The request body is too large.",
    );
  try {
    return JSON.parse(body.text);
  } catch {
    throw new TodosError(
      "TODOS_REQUEST_INVALID",
      "The body is not valid JSON.",
      [{ path: "", code: "invalid", message: "The body is not valid JSON." }],
    );
  }
}

export function createTodosRouteHandlers({
  requireUser,
  service,
  reviews,
}: TodosRouteDependencies): TodosRouteHandlers {
  async function guarded(
    work: (user: SessionUser) => Promise<Response>,
  ): Promise<Response> {
    const user = await requireUser();
    try {
      return await work(user);
    } catch (error) {
      if (error instanceof TodosError) return refusal(error);
      throw error;
    }
  }

  return {
    list: () =>
      guarded(async (user) =>
        Response.json(await service.list({ githubLogin: user.githubLogin }), {
          headers: NO_STORE,
        }),
      ),
    listForProject: (_request, projectId) =>
      guarded(async (user) =>
        Response.json(
          await service.list({ githubLogin: user.githubLogin }, { projectId }),
          { headers: NO_STORE },
        ),
      ),
    review: (request) =>
      guarded(async (user) => {
        // A change of state: never from another site.
        if (isCrossSite(request))
          throw new TodosError(
            "TODOS_CROSS_SITE_REQUEST",
            "The request does not come from this site.",
          );
        const input = readReviewInput(await readBody(request));
        if (!input.ok)
          throw new TodosError(
            "TODOS_REQUEST_INVALID",
            "The review request cannot be used.",
            input.issues,
          );
        const outcome = await reviews.submit(
          { githubLogin: user.githubLogin },
          input.value,
        );
        return Response.json(outcome, { headers: NO_STORE });
      }),
  };
}
