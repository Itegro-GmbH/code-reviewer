// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the routes of the MCP registry (#1050), with their collaborators passed in so the route files only wire the real ones
// and tests wire the real service over a test database:
//
//   GET    /api/w/:workspace/mcp/servers             the servers of the workspace (names of headers, never a value; every member)
//   POST   /api/w/:workspace/mcp/servers             adds a server (an Owner or Admin: `manage_mcp`)
//   PUT    /api/w/:workspace/mcp/servers/:id         changes a server; a header may be kept without its value (`keep: true`)
//   DELETE /api/w/:workspace/mcp/servers/:id         removes a server; refused with 409 `mcp_server_in_use`, naming the lanes, while a lane uses it
//   POST   /api/w/:workspace/mcp/servers/:id/test    connects as an MCP client, stores and returns the tool list
//
// Who is asking and in which workspace is settled before the data routes run (src/workspaces/access-runtime.ts); the role is checked here
// once more. Bodies are read the one way every JSON route of the app does (src/http/json-body.ts). Every answer is `Cache-Control: no-store`;
// a refusal is `{ "error": <code> }` with a stable code of `errors.ts`, and no answer holds a header value.
import {
  JSON_BODY_ERROR_STATUS,
  readJsonObject,
  type JsonBodyErrorCode,
} from "../http/json-body.ts";
import { isCrossSite } from "../http/request-checks.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import { can } from "../workspaces/permissions.ts";
import { MCP_ERROR_STATUS, type McpErrorCode } from "./errors.ts";
import type { McpService, McpServiceFailure } from "./service.ts";

export const MCP_REQUEST_MAX_BYTES = 32 * 1024;

const NO_STORE = { "cache-control": "no-store" };

type RefusalCode = McpErrorCode | JsonBodyErrorCode;

const STATUS: Record<RefusalCode, number> = {
  ...MCP_ERROR_STATUS,
  ...JSON_BODY_ERROR_STATUS,
};

function refusal(
  code: RefusalCode,
  more: Partial<McpServiceFailure> = {},
): Response {
  return Response.json(
    {
      error: code,
      ...(more.lanes === undefined
        ? {}
        : {
            lanes: more.lanes.map((lane) => ({
              id: lane.id,
              name: lane.name,
              projectName: lane.projectName,
            })),
          }),
    },
    {
      status: STATUS[code],
      headers: {
        ...NO_STORE,
        ...(more.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(more.retryAfterSeconds) }),
      },
    },
  );
}

export type McpRouteDependencies = {
  /** The registry of the workspace the request is in. */
  serviceFor: (workspaceId: string) => McpService;
};

export type McpRouteHandlers = {
  list(request: Request, access: WorkspaceAccess): Promise<Response>;
  create(request: Request, access: WorkspaceAccess): Promise<Response>;
  update(
    request: Request,
    access: WorkspaceAccess,
    serverId: string,
  ): Promise<Response>;
  remove(
    request: Request,
    access: WorkspaceAccess,
    serverId: string,
  ): Promise<Response>;
  test(
    request: Request,
    access: WorkspaceAccess,
    serverId: string,
  ): Promise<Response>;
};

export function createMcpRouteHandlers(
  deps: McpRouteDependencies,
): McpRouteHandlers {
  const mayManage = (access: WorkspaceAccess) => can(access.role, "manage_mcp");

  async function unavailable(): Promise<Response> {
    console.error("[mcp] MCP_UNAVAILABLE: the request was not served.");
    return refusal("unavailable");
  }

  function answer(
    result: { ok: true; value: unknown } | McpServiceFailure,
    status = 200,
  ): Response {
    return result.ok
      ? Response.json({ server: result.value }, { status, headers: NO_STORE })
      : refusal(result.error, result);
  }

  return {
    async list(_request, access) {
      try {
        return Response.json(
          { servers: await deps.serviceFor(access.workspace.id).list() },
          { headers: NO_STORE },
        );
      } catch {
        return unavailable();
      }
    },

    async create(request, access) {
      if (!mayManage(access)) return refusal("forbidden");
      const body = await readJsonObject(request, MCP_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      try {
        return answer(
          await deps
            .serviceFor(access.workspace.id)
            .create({ id: access.user.id }, body.value),
          201,
        );
      } catch {
        return unavailable();
      }
    },

    async update(request, access, serverId) {
      if (!mayManage(access)) return refusal("forbidden");
      const body = await readJsonObject(request, MCP_REQUEST_MAX_BYTES);
      if (!body.ok) return refusal(body.error);
      try {
        return answer(
          await deps
            .serviceFor(access.workspace.id)
            .update(serverId, body.value),
        );
      } catch {
        return unavailable();
      }
    },

    async remove(request, access, serverId) {
      if (isCrossSite(request)) return refusal("cross_site_request");
      if (!mayManage(access)) return refusal("forbidden");
      try {
        const result = await deps
          .serviceFor(access.workspace.id)
          .remove(serverId);
        return result.ok
          ? Response.json({ removed: true }, { headers: NO_STORE })
          : refusal(result.error, result);
      } catch {
        return unavailable();
      }
    },

    async test(request, access, serverId) {
      if (isCrossSite(request)) return refusal("cross_site_request");
      if (!mayManage(access)) return refusal("forbidden");
      try {
        return answer(
          await deps.serviceFor(access.workspace.id).test(serverId),
        );
      } catch {
        return unavailable();
      }
    },
  };
}
