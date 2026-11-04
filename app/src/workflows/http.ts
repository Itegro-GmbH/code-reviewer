// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the workflow routes (#833): `GET/POST .../workflows`, `POST .../workflows/validate` and
// `GET/PUT/DELETE .../workflows/:id` (DELETE archives), with their collaborators passed in so the route files only wire the real ones and tests wire fakes.
// Order: the user first (nothing is looked at before the caller is known), then where the request comes from, then, for a body, its
// content type and size, then the service. Every answer is `Cache-Control: no-store`. The body of a write is the workflow document
// itself. A refusal is `{ "error": <code> }` with a stable code from `errors.ts`; an invalid document adds `"errors"` (every
// problem: path, code, message, available names), a full workspace its `"maximum"`, a lost race the `"current"` version.
import { type SessionUser } from "../auth/access-policy.ts";
import { isCrossSite, isJsonRequest } from "../http/request-checks.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import { WORKFLOW_ERROR_STATUS, WorkflowError } from "./errors.ts";
import { DOCUMENT_MAX_BYTES } from "./limits.ts";
import type { WorkflowService } from "./service.ts";

export type WorkflowRouteDependencies = {
  /** The signed in user, or a throw that ends the request. Called first, on every request. */
  requireUser: () => Promise<SessionUser>;
  service: WorkflowService;
};

export type WorkflowRouteHandlers = {
  list(request: Request): Promise<Response>;
  create(request: Request): Promise<Response>;
  validate(request: Request): Promise<Response>;
  get(request: Request, workflowId: string): Promise<Response>;
  update(request: Request, workflowId: string): Promise<Response>;
  archive(request: Request, workflowId: string): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(error: WorkflowError): Response {
  return Response.json(
    {
      error: error.code,
      message: error.message,
      ...(error.errors.length > 0 ? { errors: error.errors } : {}),
      ...(error.code === "WORKFLOW_INVALID"
        ? { truncated: error.truncated ?? false }
        : {}),
      ...(error.maximum === undefined ? {} : { maximum: error.maximum }),
      ...(error.current === undefined ? {} : { current: error.current }),
    },
    { status: WORKFLOW_ERROR_STATUS[error.code], headers: NO_STORE },
  );
}

async function readBody(request: Request): Promise<unknown> {
  if (!isJsonRequest(request))
    throw new WorkflowError(
      "WORKFLOW_CONTENT_TYPE_UNSUPPORTED",
      "The body must be application/json.",
    );
  const body = await readLimitedBody(request, DOCUMENT_MAX_BYTES);
  if (!body.ok)
    throw new WorkflowError(
      "WORKFLOW_BODY_TOO_LARGE",
      "The request body is too large.",
    );
  try {
    return JSON.parse(body.text);
  } catch {
    throw new WorkflowError(
      "WORKFLOW_REQUEST_INVALID",
      "The body is not valid JSON.",
    );
  }
}

/** A whole number from the query string, or undefined when it is not given. */
function numberParam(request: Request, name: string): number | undefined {
  const value = new URL(request.url).searchParams.get(name);
  if (value === null) return undefined;
  if (!/^[1-9][0-9]{0,8}$/.test(value))
    throw new WorkflowError(
      "WORKFLOW_REQUEST_INVALID",
      `The query value ${name} must be a whole number of 1 or more.`,
    );
  return Number(value);
}

export function createWorkflowRouteHandlers({
  requireUser,
  service,
}: WorkflowRouteDependencies): WorkflowRouteHandlers {
  /** The same wrapper for every route: the user, the origin, the work, and a refusal of this module as its answer. */
  async function answer(
    request: Request,
    work: (user: SessionUser) => Promise<Response>,
  ): Promise<Response> {
    const user = await requireUser();
    try {
      if (isCrossSite(request))
        throw new WorkflowError(
          "WORKFLOW_CROSS_SITE_REQUEST",
          "The request does not come from this site.",
        );
      return await work(user);
    } catch (error) {
      if (error instanceof WorkflowError) return refusal(error);
      throw error;
    }
  }

  return {
    list: (request) =>
      answer(request, async () =>
        Response.json(await service.list(), { headers: NO_STORE }),
      ),
    create: (request) =>
      answer(request, async (user) =>
        Response.json(
          {
            workflow: await service.create(
              { id: user.id },
              await readBody(request),
            ),
          },
          { status: 201, headers: NO_STORE },
        ),
      ),
    validate: (request) =>
      answer(request, async () =>
        Response.json(await service.validate(await readBody(request)), {
          headers: NO_STORE,
        }),
      ),
    get: (request, workflowId) =>
      answer(request, async () =>
        Response.json(
          {
            workflow: await service.get(
              workflowId,
              numberParam(request, "version"),
            ),
          },
          { headers: NO_STORE },
        ),
      ),
    update: (request, workflowId) =>
      answer(request, async (user) =>
        Response.json(
          {
            workflow: await service.update(
              { id: user.id },
              workflowId,
              await readBody(request),
              numberParam(request, "expectedVersion"),
            ),
          },
          { headers: NO_STORE },
        ),
      ),
    archive: (request, workflowId) =>
      answer(request, async () =>
        Response.json(
          { workflow: await service.archive(workflowId) },
          { headers: NO_STORE },
        ),
      ),
  };
}
