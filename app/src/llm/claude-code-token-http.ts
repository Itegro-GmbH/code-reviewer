// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the routes of the Claude Code OAuth token of a workspace (#1150), with the service passed in so the route files wire
// the real one and the tests a fake or the real one over a test database:
//
//   GET    /api/w/:workspace/llm-keys/claude-code        whether a token is configured (every member)
//   PUT    /api/w/:workspace/llm-keys/claude-code        { token? }   save; an empty or missing token keeps the stored one
//   DELETE /api/w/:workspace/llm-keys/claude-code        remove the token
//   POST   /api/w/:workspace/llm-keys/claude-code/test   { token? }   check the shape of the token (the typed one, or the stored one)
//
// The same rules as the routes of the provider keys (`http.ts`): who asks and in which workspace is settled before these run
// (`withWorkspace`), a Member reaches only GET, the other three need `manage_llm_key` (an Admin or an Owner), the body is read the one way every
// JSON route reads it, the token is write-only (no answer holds it but the last four characters, for those who manage it) and nothing is logged.
//
// **The test button checks the shape and nothing else, and says so.** There is no call to make that costs nothing and stays within what the
// token is for: the token is an inference-only credential of a Claude subscription for Claude Code, and the one thing it can do on its own is
// spend that subscription (a model call) from a place that is not Claude Code. So the app does not send it to the Claude API. The test answers
// `{ ok: true, verified: false, format: "known" | "unknown" }` for a token the runner would accept (`known`: it has the shape `claude setup-token`
// prints) and `invalid_input` for one it would refuse. Whether the Claude API accepts the token is found out by its first run
// (`subscription_auth` on a refusal).
import {
  JSON_BODY_ERROR_STATUS,
  readJsonObject,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import { isCrossSite } from "../http/request-checks.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import { can } from "../workspaces/permissions.ts";
import {
  checkClaudeCodeToken,
  hasKnownTokenShape,
  type ClaudeCodeTokenIssue,
  type ClaudeCodeTokenService,
  type ClaudeCodeTokenStatus,
} from "./claude-code-token.ts";

/** A token of up to 4096 characters, which JSON may escape to six bytes each. */
export const CLAUDE_CODE_TOKEN_REQUEST_MAX_BYTES = 32 * 1024;

/** The word the routes and the page use for this slot: `/llm-keys/claude-code`. */
export const CLAUDE_CODE_TOKEN_PATH_SEGMENT = "claude-code";

const NO_STORE = { "cache-control": "no-store" };

type RefusalCode = JsonBodyErrorCode | "forbidden";

const STATUS: Record<RefusalCode, number> = {
  ...JSON_BODY_ERROR_STATUS,
  forbidden: 403,
};

function refusal(code: RefusalCode): Response {
  return Response.json(
    { error: code },
    { status: STATUS[code], headers: NO_STORE },
  );
}

function invalid(issues: ClaudeCodeTokenIssue[]): Response {
  return Response.json(
    { error: "invalid_input", issues },
    { status: STATUS.invalid_input, headers: NO_STORE },
  );
}

function done(body: object): Response {
  return Response.json(body, { headers: NO_STORE });
}

/** Every member learns whether a token exists (it decides whether a `claude-code` step can run); the rest is for those who manage it. */
function viewOf(status: ClaudeCodeTokenStatus, canManage: boolean) {
  return canManage ? status : { state: status.state };
}

export type ClaudeCodeTokenRouteDependencies = {
  /** The token service of THE WORKSPACE OF THE REQUEST (made from `access.workspace.id`). */
  token: ClaudeCodeTokenService;
};

export type ClaudeCodeTokenRouteHandlers = {
  get(request: Request, access: WorkspaceAccess): Promise<Response>;
  put(request: Request, access: WorkspaceAccess): Promise<Response>;
  remove(request: Request, access: WorkspaceAccess): Promise<Response>;
  test(request: Request, access: WorkspaceAccess): Promise<Response>;
};

export function createClaudeCodeTokenRouteHandlers({
  token,
}: ClaudeCodeTokenRouteDependencies): ClaudeCodeTokenRouteHandlers {
  // The second line behind the route's own action check: the handler asks the matrix as well.
  const mayManage = (access: WorkspaceAccess) =>
    can(access.role, "manage_llm_key");

  return {
    async get(_request, access) {
      const canManage = mayManage(access);
      return done({
        canManage,
        token: viewOf(await token.status(), canManage),
      });
    },

    async put(request, access) {
      if (!mayManage(access)) return refusal("forbidden");
      const body = await readJsonObject(
        request,
        CLAUDE_CODE_TOKEN_REQUEST_MAX_BYTES,
      );
      if (!body.ok) return refusal(body.error);
      const result = await token.save(body.value.token, access.user.id);
      if (!result.ok) return invalid(result.issues);
      return done({
        ok: true,
        changed: result.changed,
        token: viewOf(result.status, true),
      });
    },

    async remove(request, access) {
      if (!mayManage(access)) return refusal("forbidden");
      if (isCrossSite(request)) return refusal("cross_site_request");
      return done({ ok: true, removed: await token.remove() });
    },

    async test(request, access) {
      if (!mayManage(access)) return refusal("forbidden");
      const body = await readJsonObject(
        request,
        CLAUDE_CODE_TOKEN_REQUEST_MAX_BYTES,
      );
      if (!body.ok) return refusal(body.error);
      // A token typed into the field is checked as it is (and forgotten); with an empty field the stored one is.
      const typedValue = body.value.token;
      const typed =
        typedValue !== undefined &&
        typedValue !== null &&
        !(typeof typedValue === "string" && typedValue.trim() === "");
      let value: string;
      if (typed) {
        const checked = checkClaudeCodeToken(typedValue);
        if (!checked.ok)
          return invalid([{ field: "token", code: "token_invalid" }]);
        value = checked.token;
      } else {
        const stored = await token.reveal();
        if (!stored.ok)
          return invalid([{ field: "token", code: "token_required" }]);
        value = stored.token.reveal();
      }
      return done({
        ok: true,
        verified: false,
        format: hasKnownTokenShape(value) ? "known" : "unknown",
      });
    },
  };
}
