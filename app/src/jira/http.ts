// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the routes of the Jira connection (#1037), with their collaborators passed in so the route files only wire the real
// ones and tests wire the real service over a test database:
//
//   POST   /api/w/:workspace/jira/connect                 {} or { connectionId }  the address of Atlassian's consent page (a new connection, or a reconnect)
//   GET    /api/w/:workspace/jira/connections                                    the connections of the workspace, never a token (the action `start_implementer_task`: today every member)
//   POST   /api/w/:workspace/jira/choose                  { cloudId }              connects one site of a grant that covers several
//   DELETE /api/w/:workspace/jira/connections/:id                                 forgets a connection; refused while a project uses it (409, the projects named)
//   GET    /api/jira/callback                             ?code&state             where Atlassian sends the browser
//
// Who is asking and in which workspace is settled before the data routes run (src/workspaces/access-runtime.ts); the role is checked here
// once more and the service reads the membership again from the database. The data routes read the request the one way every JSON route of
// the app does (src/http/json-body.ts). The callback is Atlassian's own redirect: it takes its facts from the query, and what it does with
// them is the service's (a signed state, used once).
//
// Where a browser lands is ALWAYS a fixed page chosen here: the Integrations tab of the settings of the workspace the state named, with a
// code of our own list in the query, or `/` when no workspace can be named. Nothing Atlassian or the request said, other than a code of
// our own list, ends up in an address. Every answer is `Cache-Control: no-store`; the redirects send `Referrer-Policy: no-referrer`, so
// the state and the code in their addresses never travel in a header. No answer holds a token.
import {
  JSON_BODY_ERROR_STATUS,
  readJsonObject,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import { isCrossSite } from "../http/request-checks.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import { workspacePath } from "../workspaces/paths.ts";
import { can } from "../workspaces/permissions.ts";
import { JIRA_ERROR_STATUS, type JiraErrorCode } from "./errors.ts";
import type { JiraService } from "./service.ts";

export const JIRA_REQUEST_MAX_BYTES = 2 * 1024;

/** The Integrations tab of the settings of a workspace: where a flow ends (the Jira connection exists in the factory only). */
export const JIRA_RESULT_PLACE = "/settings/integrations";

const NO_STORE = { "cache-control": "no-store" };

type RefusalCode = JiraErrorCode | JsonBodyErrorCode | "forbidden";

const STATUS: Record<RefusalCode, number> = {
  ...JIRA_ERROR_STATUS,
  ...JSON_BODY_ERROR_STATUS,
  forbidden: 403,
};

function refusal(
  code: RefusalCode,
  extra: { retryAfterSeconds?: number; projects?: unknown } = {},
): Response {
  return Response.json(
    {
      error: code,
      ...(extra.projects === undefined ? {} : { projects: extra.projects }),
    },
    {
      status: STATUS[code],
      headers: {
        ...NO_STORE,
        ...(extra.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(extra.retryAfterSeconds) }),
      },
    },
  );
}

export type JiraRouteDependencies = {
  service: JiraService;
  /** The id of the session of the current request, or null. */
  sessionId: () => Promise<string | null>;
  /** The person and the session of a request (for the redirect), or null when there is none. */
  session: (
    request: Request,
  ) => Promise<{ userId: string; sessionId: string } | null>;
  /** The address name of a workspace, or null when there is none. */
  workspaceSlug: (workspaceId: string) => Promise<string | null>;
};

export type JiraRouteHandlers = {
  connect(request: Request, access: WorkspaceAccess): Promise<Response>;
  list(request: Request, access: WorkspaceAccess): Promise<Response>;
  choose(request: Request, access: WorkspaceAccess): Promise<Response>;
  remove(
    request: Request,
    access: WorkspaceAccess,
    connectionId: string,
  ): Promise<Response>;
  callback(request: Request): Promise<Response>;
};

export function createJiraRouteHandlers(
  deps: JiraRouteDependencies,
): JiraRouteHandlers {
  const { service } = deps;

  const mayManage = (access: WorkspaceAccess) =>
    can(access.role, "manage_connections");

  function redirectTo(location: string): Response {
    return new Response(null, {
      status: 302,
      headers: { location, "referrer-policy": "no-referrer", ...NO_STORE },
    });
  }

  async function unavailable(): Promise<Response> {
    console.error("[jira] JIRA_UNAVAILABLE: the request was not served.");
    return refusal("unavailable");
  }

  async function landing(
    workspaceId: string | null,
    code: string,
  ): Promise<Response> {
    const slug =
      workspaceId === null ? null : await deps.workspaceSlug(workspaceId);
    if (slug === null) return redirectTo("/");
    return redirectTo(
      `${workspacePath(slug, JIRA_RESULT_PLACE)}?${new URLSearchParams({ jira: code }).toString()}`,
    );
  }

  return {
    async connect(request, access) {
      if (!mayManage(access)) return refusal("forbidden");
      const body = await readJsonObject(request, JIRA_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const sessionId = await deps.sessionId();
      if (sessionId === null)
        return Response.json(
          { error: "UNAUTHENTICATED" },
          { status: 401, headers: NO_STORE },
        );
      try {
        const result = await service.startConnect(
          { id: access.user.id, sessionId },
          access.workspace.id,
          { connectionId: body.value.connectionId },
        );
        return result.ok
          ? Response.json({ ok: true, url: result.url }, { headers: NO_STORE })
          : refusal(result.error, result);
      } catch {
        return unavailable();
      }
    },

    async list(_request, access) {
      try {
        return Response.json(
          { connections: await service.list(access.workspace.id) },
          { headers: NO_STORE },
        );
      } catch {
        return unavailable();
      }
    },

    async choose(request, access) {
      if (!mayManage(access)) return refusal("forbidden");
      const body = await readJsonObject(request, JIRA_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      const sessionId = await deps.sessionId();
      if (sessionId === null)
        return Response.json(
          { error: "UNAUTHENTICATED" },
          { status: 401, headers: NO_STORE },
        );
      try {
        const result = await service.choose(
          { id: access.user.id, sessionId },
          access.workspace.id,
          { cloudId: body.value.cloudId },
        );
        return result.ok
          ? Response.json({ ok: true }, { headers: NO_STORE })
          : refusal(result.error);
      } catch {
        return unavailable();
      }
    },

    async remove(request, access, connectionId) {
      if (isCrossSite(request)) return refusal("cross_site_request");
      if (!mayManage(access)) return refusal("forbidden");
      const sessionId = await deps.sessionId();
      if (sessionId === null)
        return Response.json(
          { error: "UNAUTHENTICATED" },
          { status: 401, headers: NO_STORE },
        );
      try {
        const result = await service.remove(
          { id: access.user.id, sessionId },
          access.workspace.id,
          connectionId,
        );
        return result.ok
          ? Response.json({ ok: true }, { headers: NO_STORE })
          : refusal(result.error, result);
      } catch {
        return unavailable();
      }
    },

    async callback(request) {
      const url = new URL(request.url);
      let who: { userId: string; sessionId: string } | null;
      try {
        who = await deps.session(request);
      } catch {
        return Response.redirect(
          new URL("/login?error=sign_in_unavailable", url),
          302,
        );
      }
      // Nobody is signed in here: a flow cannot be completed by somebody else's browser.
      if (who === null)
        return new Response(null, {
          status: 302,
          headers: { location: "/login", ...NO_STORE },
        });
      try {
        const result = await service.completeCallback(
          { id: who.userId, sessionId: who.sessionId },
          {
            code: url.searchParams.get("code") ?? undefined,
            state: url.searchParams.get("state") ?? undefined,
            error: url.searchParams.get("error") ?? undefined,
          },
        );
        return await landing(result.workspaceId, result.code);
      } catch {
        console.error("[jira] JIRA_UNAVAILABLE: the request was not served.");
        return landing(null, "unavailable");
      }
    },
  };
}
