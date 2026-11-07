// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the run routes (#844): `POST/GET .../workflows/:id/runs`, `GET .../workflows/:id/runs/:runId` and (#891, #921) `POST .../runs/:runId/discard` (`cancel` forwards to it), `pause` and `resume`, with their
// collaborators passed in so the route files only wire the real ones and tests wire fakes. Order, as for the other factory routes: the
// user first, then where the request comes from, then (for a body) its content type and size, then the service. Every answer is
// `Cache-Control: no-store`. A refusal is `{ "error": <code>, "message": ... }` with a stable code from `errors.ts`.
import { actorName, type SessionUser } from "../auth/access-policy.ts";
import { isCrossSite, isJsonRequest } from "../http/request-checks.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import { WORKFLOW_RUN_ERROR_STATUS, WorkflowRunError } from "./errors.ts";
import { TRIGGER_INPUT_MAX_CHARS } from "./limits.ts";
import type { WorkflowRunService } from "./service.ts";

/** The body of a start: the input (64 KB at most) and the request id, with room for the keys. */
export const START_BODY_MAX_BYTES = 2 * TRIGGER_INPUT_MAX_CHARS;

export type WorkflowRunRouteDependencies = {
  /** The signed in user, or a throw that ends the request. Called first, on every request. */
  requireUser: () => Promise<SessionUser>;
  service: WorkflowRunService;
};

export type WorkflowRunRouteHandlers = {
  start(request: Request, workflowId: string): Promise<Response>;
  list(request: Request, workflowId: string): Promise<Response>;
  get(request: Request, workflowId: string, runId: string): Promise<Response>;
  /**
   * #920: answers the question a run waits for: `{ question: { stepRunId, n }, choice?, text? }` (the question that is answered, and an option by its number from 1, a text, or both). 202 `{ run }` once the
   * step goes on (the turn that continues the session starts after the response); 409 `WORKFLOW_RUN_NOT_WAITING` when nothing waits for an
   * answer or it was answered before; 409 `WORKFLOW_RUN_QUESTION_CHANGED` when another question waits than the one named; 422 `WORKFLOW_RUN_ANSWER_INVALID`; 404 `WORKFLOW_RUN_NOT_FOUND`.
   */
  answer(
    request: Request,
    workflowId: string,
    runId: string,
  ): Promise<Response>;
  /**
   * #921: discards a run, whatever state it is in. 200 `{ run, outcome: "discarded" }` (the run is `discarded` now: its turn is asked to stop,
   * its ticket is free), 200 `{ run, outcome: "already_discarded" }` for a repeat; 404 `WORKFLOW_RUN_NOT_FOUND`.
   */
  discard(
    request: Request,
    workflowId: string,
    runId: string,
  ): Promise<Response>;
  /** #891: the old route of the same call; it forwards to `discard` and answers the same (#921). */
  cancel(
    request: Request,
    workflowId: string,
    runId: string,
  ): Promise<Response>;
  /**
   * #921: asks a run to stop after its current step (`pause`) or lets it go on (`resume`). 200 `{ run, outcome }` with `changed`, or
   * `unchanged` for a repeat and for a run that is over; 404 `WORKFLOW_RUN_NOT_FOUND`.
   */
  pause(request: Request, workflowId: string, runId: string): Promise<Response>;
  resume(
    request: Request,
    workflowId: string,
    runId: string,
  ): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(error: WorkflowRunError): Response {
  return Response.json(
    {
      error: error.code,
      message: error.message,
      ...(error.errors.length > 0 ? { errors: error.errors } : {}),
      ...(error.issues.length > 0 ? { issues: error.issues } : {}),
      ...(error.runId === undefined ? {} : { runId: error.runId }),
      ...(error.step === undefined ? {} : { step: error.step }),
    },
    { status: WORKFLOW_RUN_ERROR_STATUS[error.code], headers: NO_STORE },
  );
}

async function readBody(request: Request): Promise<unknown> {
  if (!isJsonRequest(request))
    throw new WorkflowRunError(
      "WORKFLOW_RUN_CONTENT_TYPE_UNSUPPORTED",
      "The body must be application/json.",
    );
  const body = await readLimitedBody(request, START_BODY_MAX_BYTES);
  if (!body.ok)
    throw new WorkflowRunError(
      "WORKFLOW_RUN_BODY_TOO_LARGE",
      "The request body is too large.",
    );
  try {
    return JSON.parse(body.text);
  } catch {
    throw new WorkflowRunError(
      "WORKFLOW_RUN_REQUEST_INVALID",
      "The body is not valid JSON.",
    );
  }
}

export function createWorkflowRunRouteHandlers({
  requireUser,
  service,
}: WorkflowRunRouteDependencies): WorkflowRunRouteHandlers {
  async function guarded(
    request: Request,
    work: (user: SessionUser) => Promise<Response>,
  ): Promise<Response> {
    const user = await requireUser();
    try {
      if (isCrossSite(request))
        throw new WorkflowRunError(
          "WORKFLOW_RUN_CROSS_SITE_REQUEST",
          "The request does not come from this site.",
        );
      return await work(user);
    } catch (error) {
      if (error instanceof WorkflowRunError) return refusal(error);
      throw error;
    }
  }

  return {
    start: (request, workflowId) =>
      guarded(request, async (user) => {
        const started = await service.start(
          // The login recorded as the one who started the run, as for a task: the GitHub login, or the email of an account without GitHub.
          { id: user.id, githubLogin: actorName(user) },
          workflowId,
          await readBody(request),
        );
        return Response.json(
          { run: started.run },
          { status: started.created ? 201 : 200, headers: NO_STORE },
        );
      }),
    list: (request, workflowId) =>
      guarded(request, async () =>
        Response.json(await service.list(workflowId), { headers: NO_STORE }),
      ),
    get: (request, workflowId, runId) =>
      guarded(request, async () =>
        Response.json(
          { run: await service.get(workflowId, runId) },
          { headers: NO_STORE },
        ),
      ),
    answer: (request, workflowId, runId) =>
      guarded(request, async (user) => {
        const answered = await service.answer(
          // The GitHub login or none: what is recorded with the answer is shown on the ticket, where an email must never appear.
          { id: user.id, githubLogin: user.githubLogin },
          workflowId,
          runId,
          await readBody(request),
        );
        return Response.json(answered, { status: 202, headers: NO_STORE });
      }),
    discard: (request, workflowId, runId) =>
      guarded(request, async () =>
        Response.json(await service.discard(workflowId, runId), {
          headers: NO_STORE,
        }),
      ),
    cancel: (request, workflowId, runId) =>
      guarded(request, async () =>
        Response.json(await service.cancel(workflowId, runId), {
          headers: NO_STORE,
        }),
      ),
    pause: (request, workflowId, runId) =>
      guarded(request, async () =>
        Response.json(await service.pause(workflowId, runId), {
          headers: NO_STORE,
        }),
      ),
    resume: (request, workflowId, runId) =>
      guarded(request, async () =>
        Response.json(await service.resume(workflowId, runId), {
          headers: NO_STORE,
        }),
      ),
  };
}
