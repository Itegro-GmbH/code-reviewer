// SPDX-License-Identifier: LicenseRef-Proprietary

// The calls the settings page makes to the routes of the Claude Code OAuth token (`src/llm/claude-code-token-http.ts`). Browser side. The
// token travels in the body of a save or a test and in nothing else. Nothing throws; a failure is a stable code the page translates.
import {
  requestJson,
  type FetchLike,
  type RequestResult,
} from "../../ui/json-request.ts";
import { workspaceApiPath } from "../../workspaces/paths.ts";
import type { ClaudeCodeTokenStatus } from "../claude-code-token.ts";

export type SaveTokenAnswer = {
  ok: true;
  changed: boolean;
  token: ClaudeCodeTokenStatus;
};

/** The test checks the shape only (`verified` is always false): `known` is the shape `claude setup-token` prints. */
export type TestTokenAnswer = {
  ok: true;
  verified: false;
  format: "known" | "unknown";
};

export type ClaudeCodeTokenApi = {
  /** An empty `token` keeps the stored one. */
  save(token: string): Promise<RequestResult<SaveTokenAnswer>>;
  remove(): Promise<RequestResult<{ ok: true; removed: boolean }>>;
  /** Checks the typed token, or the stored one when `token` is empty. */
  test(token: string): Promise<RequestResult<TestTokenAnswer>>;
};

export function createClaudeCodeTokenApi(
  fetchImpl: FetchLike,
  workspaceSlug: string,
): ClaudeCodeTokenApi {
  const path = (rest = "") =>
    workspaceApiPath(workspaceSlug, `/llm-keys/claude-code${rest}`);
  return {
    save: (token) => requestJson(fetchImpl, "PUT", path(), { token }),
    remove: () => requestJson(fetchImpl, "DELETE", path()),
    test: (token) => requestJson(fetchImpl, "POST", path("/test"), { token }),
  };
}

export const browserClaudeCodeTokenApi = (
  workspaceSlug: string,
): ClaudeCodeTokenApi =>
  createClaudeCodeTokenApi((url, init) => fetch(url, init), workspaceSlug);
