// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the routes of the binding, with their collaborators passed in so the route files only wire
// the real ones and tests wire the real services over a test database:
//
//   POST   /api/w/:workspace/github/connect                  {}                       the address of GitHub's installation page
//   POST   /api/w/:workspace/github/installations           {}                       the address of GitHub's authorization page, to list the installations
//   POST   /api/w/:workspace/github/installations/choose     { picker, installationId } the address of the authorization page, to link one of them
//   DELETE /api/w/:workspace/integrations/:integrationId                              ends the connection (it stays the workspace's)
//   POST   /api/w/:workspace/integrations/sync                                        reads the workspace's connections from GitHub now
//   GET    /github/connected                                 ?installation_id&setup_action&state  where GitHub sends the browser after an installation
//   GET    /api/auth/callback/github                         ?code&state              the authorization's callback, for a state of this flow
//
// Who is asking and in which workspace is settled before the data routes run (src/workspaces/access-runtime.ts);
// the role is checked here once more and the service reads the membership again from the database. The data routes
// read the request the one way every JSON route of the app does (src/http/json-body.ts): same site,
// `application/json` only, a small limit, read and parsed once. The two GET routes are GitHub's own redirects:
// they take their facts from the query, and what they do with it is the service's (a signed state, used once).
//
// Where a browser lands is ALWAYS a fixed page chosen here: `/w/<slug>/connections` (the Integrations tab of the settings in the factory, #925) for a workspace the person
// administers, `/github/result` for the rest. Nothing GitHub or the request said, other than a code of our own
// list, ends up in an address, so a crafted `redirect` or `next` parameter has nothing to act on. Every answer is
// `Cache-Control: no-store`; the redirects send `Referrer-Policy: no-referrer`, so the state and the code in
// their addresses never travel in a header.
import {
  JSON_BODY_ERROR_STATUS,
  readJsonObject,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import { isCrossSite } from "../http/request-checks.ts";
import type { CapabilitySet } from "../capabilities/capability.ts";
import type { IntegrationSyncService } from "../integrations/sync/service.ts";
import { can } from "../workspaces/permissions.ts";
import { connectionsPlace, workspacePath } from "../workspaces/paths.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import type { Connections } from "./connections.ts";
import { BINDING_ERROR_STATUS, type BindingErrorCode } from "./errors.ts";
import type { LimitResult } from "./rate-limits.ts";
import type { CallbackResult, InstallationBindingService } from "./service.ts";

export const BINDING_REQUEST_MAX_BYTES = 4 * 1024;

/** Where a flow ends when no workspace the person administers can be named. */
export const BINDING_RESULT_PAGE = "/github/result";
export const SETUP_CALLBACK_PATH = "/github/connected";
export const AUTHORIZATION_CALLBACK_PATH = "/api/auth/callback/github";

const NO_STORE = { "cache-control": "no-store" };

type RefusalCode = BindingErrorCode | JsonBodyErrorCode | "forbidden";

const STATUS: Record<RefusalCode, number> = {
  ...BINDING_ERROR_STATUS,
  ...JSON_BODY_ERROR_STATUS,
  forbidden: 403,
};

function refusal(code: RefusalCode, retryAfterSeconds?: number): Response {
  return Response.json(
    { error: code },
    {
      status: STATUS[code],
      headers: {
        ...NO_STORE,
        ...(retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(retryAfterSeconds) }),
      },
    },
  );
}

export type BindingRouteDependencies = {
  service: InstallationBindingService;
  connections: Connections;
  sync: Pick<IntegrationSyncService, "syncWorkspace">;
  /** The id of the session of the current request, or null. */
  sessionId: () => Promise<string | null>;
  /** The person and the session of a request (for the two redirects), or null when there is none. */
  session: (
    request: Request,
  ) => Promise<{ userId: string; sessionId: string } | null>;
  /** The address name of a workspace, or null when there is none. */
  workspaceSlug: (workspaceId: string) => Promise<string | null>;
  /** Counts a press of the workspace's sync button against the shared limits (rate-limits.ts, `sync`). */
  syncLimit: (userId: string) => Promise<LimitResult>;
  /** Whether a `state` is one of the authorization of this flow (its signature is ours and so is its purpose). */
  isAuthorizationState: (state: string) => boolean;
  /** The capability set of the deployment, which says where the connections are shown (`connectionsPlace`); left out, code-review.com. */
  capabilities?: () => CapabilitySet;
};

export type BindingRouteHandlers = {
  connect(request: Request, access: WorkspaceAccess): Promise<Response>;
  startPicker(request: Request, access: WorkspaceAccess): Promise<Response>;
  choose(request: Request, access: WorkspaceAccess): Promise<Response>;
  disconnect(
    request: Request,
    access: WorkspaceAccess,
    integrationId: string,
  ): Promise<Response>;
  syncWorkspace(request: Request, access: WorkspaceAccess): Promise<Response>;
  setupCallback(request: Request): Promise<Response>;
  /** Resolves to null when the request is not one of this flow (the caller hands it on). */
  authorizationCallback(request: Request): Promise<Response | null>;
};

/**
 * What a workspace's synchronization answers: how many repositories are new and what went wrong, for its own
 * connections. Only the stable code of each problem: a person of a workspace gets no text written for the
 * operator of the instance (the page translates the code).
 */
export type WorkspaceSyncAnswer = {
  added: number;
  errors: { code: string }[];
};

export function createBindingRouteHandlers(
  deps: BindingRouteDependencies,
): BindingRouteHandlers {
  const { service, connections, sync } = deps;

  function mayManage(access: WorkspaceAccess): boolean {
    return can(access.role, "manage_connections");
  }

  /** The common start of a data route that makes an address to go to. */
  async function start(
    request: Request,
    access: WorkspaceAccess,
    run: (
      actor: { id: string; sessionId: string },
      body: Record<string, unknown>,
    ) => ReturnType<InstallationBindingService["startConnect"]>,
  ): Promise<Response> {
    if (!mayManage(access)) return refusal("forbidden");
    const body = await readJsonObject(request, BINDING_REQUEST_MAX_BYTES);
    if (!body.ok) return refusal(body.error);
    const sessionId = await deps.sessionId();
    if (sessionId === null)
      return Response.json(
        { error: "UNAUTHENTICATED" },
        { status: 401, headers: NO_STORE },
      );
    try {
      const result = await run({ id: access.user.id, sessionId }, body.value);
      if (result.ok)
        return Response.json(
          { ok: true, url: result.url },
          { headers: NO_STORE },
        );
      return refusal(result.error, result.retryAfterSeconds);
    } catch {
      console.error(
        "[installation-binding] BINDING_UNAVAILABLE: the request was not served.",
      );
      return refusal("unavailable");
    }
  }

  /** Where the browser lands after a flow: a fixed page, with a code of our own list in the query. */
  async function landing(result: CallbackResult): Promise<Response> {
    const redirectTo = (location: string): Response =>
      new Response(null, {
        status: 302,
        headers: {
          location,
          "referrer-policy": "no-referrer",
          ...NO_STORE,
        },
      });
    if (result.kind === "authorize") return redirectTo(result.url);
    const slug =
      result.workspaceId === null
        ? null
        : await deps.workspaceSlug(result.workspaceId);
    if (slug === null)
      return redirectTo(`${BINDING_RESULT_PAGE}?github=${result.code}`);
    const query = new URLSearchParams({ github: result.code });
    if (result.picker !== undefined) query.set("picker", result.picker);
    return redirectTo(
      `${workspacePath(slug, connectionsPlace(deps.capabilities?.()))}?${query.toString()}`,
    );
  }

  /** The two redirects: who is asking, then the service; everything unexpected ends on the result page. */
  async function callback(
    request: Request,
    run: (
      actor: { id: string; sessionId: string },
      query: URLSearchParams,
    ) => Promise<CallbackResult>,
  ): Promise<Response> {
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
      return await landing(
        await run(
          { id: who.userId, sessionId: who.sessionId },
          url.searchParams,
        ),
      );
    } catch {
      console.error(
        "[installation-binding] BINDING_UNAVAILABLE: the request was not served.",
      );
      return landing({ kind: "done", workspaceId: null, code: "unavailable" });
    }
  }

  return {
    connect: (request, access) =>
      start(request, access, (actor) =>
        service.startConnect(actor, access.workspace.id),
      ),

    startPicker: (request, access) =>
      start(request, access, (actor) =>
        service.startPicker(actor, access.workspace.id),
      ),

    choose: (request, access) =>
      start(request, access, (actor, body) =>
        service.chooseFromPicker(actor, access.workspace.id, {
          picker: body.picker,
          installationId: body.installationId,
        }),
      ),

    async disconnect(request, access, integrationId) {
      if (isCrossSite(request)) return refusal("cross_site_request");
      if (!mayManage(access)) return refusal("forbidden");
      try {
        const result = await connections.disconnect({
          workspaceId: access.workspace.id,
          integrationId,
        });
        return result.ok
          ? Response.json({ ok: true }, { headers: NO_STORE })
          : refusal(result.error);
      } catch {
        console.error(
          "[installation-binding] BINDING_UNAVAILABLE: the request was not served.",
        );
        return refusal("unavailable");
      }
    },

    async syncWorkspace(request, access) {
      if (isCrossSite(request)) return refusal("cross_site_request");
      if (!mayManage(access)) return refusal("forbidden");
      try {
        const limit = await deps.syncLimit(access.user.id);
        if (!limit.allowed)
          return refusal("rate_limited", limit.retryAfterSeconds);
        const summary = await sync.syncWorkspace(access.workspace.id);
        const answer: WorkspaceSyncAnswer = {
          added: summary.repositories.added,
          errors: summary.errors.map((error) => ({ code: error.code })),
        };
        return Response.json(answer, { headers: NO_STORE });
      } catch {
        console.error(
          "[installation-binding] BINDING_UNAVAILABLE: the request was not served.",
        );
        return refusal("unavailable");
      }
    },

    setupCallback(request) {
      if (request.method !== "GET")
        return Promise.resolve(new Response(null, { status: 405 }));
      return callback(request, (actor, query) =>
        service.completeSetup(actor, {
          installationId: query.get("installation_id"),
          setupAction: query.get("setup_action"),
          state: query.get("state"),
        }),
      );
    },

    async authorizationCallback(request) {
      const url = new URL(request.url);
      if (
        request.method !== "GET" ||
        url.pathname !== AUTHORIZATION_CALLBACK_PATH
      )
        return null;
      const state = url.searchParams.get("state");
      if (state === null || !deps.isAuthorizationState(state)) return null;
      return callback(request, (actor, query) =>
        service.completeAuthorization(actor, {
          code: query.get("code"),
          state: query.get("state"),
          error: query.get("error"),
        }),
      );
    },
  };
}
