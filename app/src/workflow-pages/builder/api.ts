// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the lane builder makes to the app's own workflow routes (#926): check a document, and save it as the next version. The same
// routes an AI uses (`docs/workflows.md`, "The API"); the workspace is the one of the page. Browser side; no secrets.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import type { Problem } from "./problems.ts";

export type ValidateAnswer = {
  valid: boolean;
  errors: Problem[];
  truncated: boolean;
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

export type BuilderApi = {
  /** Checks a document; stores nothing. An invalid document is an answer (`valid: false`), not a failure. */
  validate(document: unknown): Promise<RequestResult<ValidateAnswer>>;
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
    validate: (document) =>
      requestJson<ValidateAnswer>(
        fetchImpl,
        "POST",
        workspaceApiPath(workspaceSlug, "/workflows/validate"),
        document,
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
