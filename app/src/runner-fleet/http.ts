// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the routes of the runners page (#854): `GET .../runners`, `POST .../runners/tokens` and `POST
// .../runners/:id/revoke`, with their collaborators passed in so the route files only wire the real ones and tests wire fakes. Order:
// the user first (nothing is looked at before the caller is known), then where the request comes from, then the service. Every
// answer is `Cache-Control: no-store` (the token is in one of them). A refusal is `{ "error": <code> }` with a stable code from
// `errors.ts`.
import { type SessionUser } from "../auth/access-policy.ts";
import { isCrossSite } from "../http/request-checks.ts";
import { RUNNER_FLEET_ERROR_STATUS, RunnerFleetError } from "./errors.ts";
import type { RunnerFleetService } from "./service.ts";

export type RunnerFleetRouteDependencies = {
  /** The signed in user, or a throw that ends the request. Called first, on every request. */
  requireUser: () => Promise<SessionUser>;
  service: RunnerFleetService;
};

export type RunnerFleetRouteHandlers = {
  list(request: Request): Promise<Response>;
  createToken(request: Request): Promise<Response>;
  revoke(request: Request, runnerId: string): Promise<Response>;
};

const NO_STORE = { "cache-control": "no-store" };

function refusal(error: RunnerFleetError): Response {
  return Response.json(
    {
      error: error.code,
      ...(error.maximum === undefined ? {} : { maximum: error.maximum }),
    },
    { status: RUNNER_FLEET_ERROR_STATUS[error.code], headers: NO_STORE },
  );
}

export function createRunnerFleetRouteHandlers({
  requireUser,
  service,
}: RunnerFleetRouteDependencies): RunnerFleetRouteHandlers {
  async function answer(
    request: Request,
    work: (user: SessionUser) => Promise<Response>,
  ): Promise<Response> {
    const user = await requireUser();
    try {
      if (isCrossSite(request))
        throw new RunnerFleetError(
          "RUNNER_FLEET_CROSS_SITE_REQUEST",
          "The request does not come from this site.",
        );
      return await work(user);
    } catch (error) {
      if (error instanceof RunnerFleetError) return refusal(error);
      throw error;
    }
  }

  return {
    list: (request) =>
      answer(request, async () =>
        Response.json(await service.list(), { headers: NO_STORE }),
      ),
    createToken: (request) =>
      answer(request, async (user) =>
        Response.json(await service.createToken({ id: user.id }), {
          status: 201,
          headers: NO_STORE,
        }),
      ),
    revoke: (request, runnerId) =>
      answer(request, async () => {
        await service.revoke(runnerId);
        return Response.json({ revoked: true }, { headers: NO_STORE });
      }),
  };
}
