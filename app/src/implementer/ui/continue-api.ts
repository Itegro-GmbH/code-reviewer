// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the "Continue" form makes (#841): what the run offers (`GET .../runs/:id/continuation`), the next instruction (`POST
// .../implementer/sessions/:sessionId/turns`), and the models and environments it already reads for the first form. Browser side; no
// secrets here.
import type { ModelChoice } from "../../db/implementer-model-choice.ts";
import type { DiscardReason } from "../../db/repositories/implementer-repository.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { Continuation } from "../follow-up.ts";
import { createImplementerApi, type ImplementerApi } from "./api.ts";

export type { Continuation, DiscardReason };

/** The body of `POST .../implementer/sessions/:sessionId/turns`. What is left out is as the last turn had it. */
export type ContinueRequest = {
  instruction: string;
  /** One per body: a retry of the same body is the same instruction. */
  clientRequestId: string;
  model?: ModelChoice;
  /** Whole US cents; `null`: no limit of the person's own (the operator's maximum applies). */
  costLimitCents?: number | null;
  /** `null`: no environment (the standard). */
  environmentId?: string | null;
};

export type ContinueAnswer = {
  status: "started" | "queued";
  sessionId: string;
  runId: string | null;
  turnNumber: number | null;
};

export type ContinueApi = Pick<ImplementerApi, "models" | "environments"> & {
  continuation(runId: string): Promise<RequestResult<Continuation>>;
  continueSession(
    sessionId: string,
    request: ContinueRequest,
  ): Promise<RequestResult<ContinueAnswer>>;
};

export function createContinueApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): ContinueApi {
  const first = createImplementerApi(fetchImpl, workspaceSlug);
  return {
    models: first.models,
    environments: first.environments,
    continuation: (runId) =>
      requestJson(
        fetchImpl,
        "GET",
        workspaceApiPath(
          workspaceSlug,
          `/runs/${encodeURIComponent(runId)}/continuation`,
        ),
      ),
    continueSession: (sessionId, request) =>
      requestJson(
        fetchImpl,
        "POST",
        workspaceApiPath(
          workspaceSlug,
          `/implementer/sessions/${encodeURIComponent(sessionId)}/turns`,
        ),
        request,
      ),
  };
}

/** The real thing, for the component; tests hand in their own. */
export function browserContinueApi(workspaceSlug: string): ContinueApi {
  return createContinueApi((url, init) => fetch(url, init), workspaceSlug);
}
