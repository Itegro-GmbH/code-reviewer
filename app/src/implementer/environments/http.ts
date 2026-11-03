// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the environment routes (#818): `GET .../environments`, `POST .../environments`, `PUT .../environments/:id`
// and `DELETE .../environments/:id`, with their collaborators passed in so the route files only wire the real ones and tests wire
// fakes. Order: the user first (nothing is looked at before the caller is known), then where the request comes from, then, for a
// write with a body, its content type and size, then the service. Every answer is `Cache-Control: no-store`. A refusal is `{
// "error": <code> }` with a stable code from `errors.ts`; an unusable body adds `"issues"`, a full workspace its `"maximum"`.
import { type SessionUser } from "../../auth/access-policy.ts";
import { isCrossSite, isJsonRequest } from "../../http/request-checks.ts";
import { readLimitedBody } from "../../webhooks/limited-body.ts";
import { ENVIRONMENT_ERROR_STATUS, EnvironmentError } from "./errors.ts";
import { SETUP_SCRIPT_MAX_BYTES } from "./limits.ts";
import type { EnvironmentService } from "./service.ts";

/**
 * The script is at most 64 KB of UTF-8, and a JSON string writes a control character as the six characters `\u001b`, so the
 * largest honest body is about six times that, plus the other fields.
 */
export const ENVIRONMENT_REQUEST_MAX_BYTES = 7 * SETUP_SCRIPT_MAX_BYTES;

export type EnvironmentRouteDependencies = {
  /** The signed in user, or a throw that ends the request. Called first, on every request. */
  requireUser: () => Promise<SessionUser>;
  service: EnvironmentService;
};

export type EnvironmentRouteHandlers = {
  list(request: Request): Promise<Response>;
  create(request: Request): Promise<Response>;
  update(request: Request, environmentId: string): Promise<Response>;
  remove(request: Request, environmentId: string): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(error: EnvironmentError): Response {
  return Response.json(
    {
      error: error.code,
      ...(error.issues.length > 0 ? { issues: error.issues } : {}),
      ...(error.maximum === undefined ? {} : { maximum: error.maximum }),
    },
    { status: ENVIRONMENT_ERROR_STATUS[error.code], headers: NO_STORE },
  );
}

async function readBody(request: Request): Promise<unknown> {
  if (!isJsonRequest(request))
    throw new EnvironmentError(
      "ENVIRONMENT_CONTENT_TYPE_UNSUPPORTED",
      "The body must be application/json.",
    );
  const body = await readLimitedBody(request, ENVIRONMENT_REQUEST_MAX_BYTES);
  if (!body.ok)
    throw new EnvironmentError(
      "ENVIRONMENT_BODY_TOO_LARGE",
      "The request body is too large.",
    );
  try {
    return JSON.parse(body.text);
  } catch {
    throw new EnvironmentError(
      "ENVIRONMENT_REQUEST_INVALID",
      "The body is not valid JSON.",
    );
  }
}

export function createEnvironmentRouteHandlers({
  requireUser,
  service,
}: EnvironmentRouteDependencies): EnvironmentRouteHandlers {
  /** The same wrapper for every route: the user, the origin, the work, and a refusal of this module as its answer. */
  async function answer(
    request: Request,
    work: (user: SessionUser) => Promise<Response>,
  ): Promise<Response> {
    const user = await requireUser();
    try {
      if (isCrossSite(request))
        throw new EnvironmentError(
          "ENVIRONMENT_CROSS_SITE_REQUEST",
          "The request does not come from this site.",
        );
      return await work(user);
    } catch (error) {
      if (error instanceof EnvironmentError) return refusal(error);
      throw error;
    }
  }

  return {
    list: (request) =>
      answer(request, async () => {
        // `?view=picker`: the list for the form's picker, without the scripts. Any other view is refused.
        const view = new URL(request.url).searchParams.get("view");
        if (view !== null && view !== "picker")
          throw new EnvironmentError(
            "ENVIRONMENT_REQUEST_INVALID",
            "The view is not one that exists.",
          );
        return Response.json(
          view === "picker"
            ? await service.listForPicker()
            : await service.list(),
          { headers: NO_STORE },
        );
      }),
    create: (request) =>
      answer(request, async (user) =>
        Response.json(
          {
            environment: await service.create(
              { id: user.id },
              await readBody(request),
            ),
          },
          { status: 201, headers: NO_STORE },
        ),
      ),
    update: (request, environmentId) =>
      answer(request, async () =>
        Response.json(
          {
            environment: await service.update(
              environmentId,
              await readBody(request),
            ),
          },
          { headers: NO_STORE },
        ),
      ),
    remove: (request, environmentId) =>
      answer(request, async () => {
        await service.remove(environmentId);
        // A body, so that the page's JSON call reads the answer like every other (an empty 204 reads as an unexpected answer).
        return Response.json({ removed: true }, { headers: NO_STORE });
      }),
  };
}
