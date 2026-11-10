// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the lane builder makes to the app's own workflow routes (#926): check a document, and save it as the next version. The same
// routes an AI uses (`docs/workflows.md`, "The API"); the workspace is the one of the page. Browser side; no secrets.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import type { ReachWants, ScopeAnswer } from "../../workflows/reach.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import type { Problem } from "./problems.ts";

export type ValidateAnswer = {
  valid: boolean;
  errors: Problem[];
  truncated: boolean;
  /** What is said and does not stop a save (#973). Left out when there is none. */
  warnings?: Problem[];
  steps: number;
  budgetUsd?: number;
};

export type SavedWorkflow = {
  id: string;
  name: string;
  version: number;
  documentVersion: number;
  document: unknown;
  versions: { version: number; savedAt: string }[];
};

/** What the picker asks for (#927): the values the node at `at` can reach; `targetRoots` for a field that takes one trusted value, `wants` for a field the validator holds to a kind of value. */
export type ScopeRequest = {
  at: string;
  targetRoots?: readonly string[];
  wants?: ReachWants;
};

/** The values a field can reach, asked of the current document of the builder; the builder fills in the document and the lane. */
export type ReachLookup = (
  request: ScopeRequest,
  signal?: AbortSignal,
) => Promise<RequestResult<ScopeAnswer>>;

export type BuilderApi = {
  /** Checks a document; stores nothing. An invalid document is an answer (`valid: false`), not a failure. A `signal` cancels a check nobody waits for any more. */
  validate(
    document: unknown,
    signal?: AbortSignal,
  ): Promise<RequestResult<ValidateAnswer>>;
  /** The values a node of a document can reach (`POST .../workflows/scope`); `workflowId` is the lane whose latest run gives the samples. */
  scope(
    document: unknown,
    request: ScopeRequest,
    workflowId: string,
    signal?: AbortSignal,
  ): Promise<RequestResult<ScopeAnswer>>;
  /** Saves the document as the next version, only if `expectedVersion` is still the current one. */
  save(
    workflowId: string,
    document: unknown,
    expectedVersion: number,
  ): Promise<RequestResult<{ workflow: SavedWorkflow }>>;
};

export function createBuilderApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): BuilderApi {
  return {
    validate: (document, signal) =>
      requestJson<ValidateAnswer>(
        fetchImpl,
        "POST",
        workspaceApiPath(workspaceSlug, "/workflows/validate"),
        document,
        signal,
      ),
    scope: (document, request, workflowId, signal) =>
      requestJson<ScopeAnswer>(
        fetchImpl,
        "POST",
        workspaceApiPath(workspaceSlug, "/workflows/scope"),
        {
          document,
          at: request.at,
          ...(request.targetRoots === undefined
            ? {}
            : { targetRoots: request.targetRoots }),
          ...(request.wants === undefined ? {} : { wants: request.wants }),
          workflowId,
        },
        signal,
      ),
    save: (workflowId, document, expectedVersion) =>
      requestJson<{ workflow: SavedWorkflow }>(
        fetchImpl,
        "PUT",
        `${workspaceApiPath(workspaceSlug, `/workflows/${encodeURIComponent(workflowId)}`)}?expectedVersion=${String(expectedVersion)}`,
        document,
      ),
  };
}

export function browserBuilderApi(workspaceSlug: string): BuilderApi {
  return createBuilderApi((url, init) => fetch(url, init), workspaceSlug);
}

/** How long the builder waits after a change before it asks the validator, so typing is not one call per key. */
export const VALIDATE_DEBOUNCE_MS = 300;
