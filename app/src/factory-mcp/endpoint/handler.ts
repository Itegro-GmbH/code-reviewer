// SPDX-License-Identifier: LicenseRef-Proprietary

// `POST /api/mcp`: the Streamable HTTP endpoint of the factory MCP (MCP specification 2025-06-18), stateless: every request carries its own
// bearer token and builds its own server, so it runs on any number of Vercel instances with nothing kept in memory. The steps, in order:
//
// 1. A request without a valid access token is 401 with `WWW-Authenticate: Bearer resource_metadata="..."` (RFC 9728), which is how a client
//    finds the authorization server. The token is read from the `Authorization` header only, never from the address or the body.
// 2. The token is checked against the store (`OAuthService.authenticate`): known, not expired, not revoked, made for THIS endpoint (the
//    audience), and its person is still a member of its workspace, with the role they have now.
// 3. For a `tools/call` of a tool whose scope the token lacks the answer is 403 `insufficient_scope` (so a client can ask for more), before the
//    tool is looked at any further. The registry checks the scope, the role and the arguments again for every tool.
// 4. The MCP SDK's low level server and its web standard transport answer `initialize`, `tools/list`, `tools/call` and `ping` as JSON.
//
// The workspace is the token's and nothing else: no tool takes one as an argument. The endpoint accepts no cookie, so a browser on another
// site cannot act through it (the `Origin` header is therefore not checked, as it protects servers that trust ambient credentials).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import { readLimitedBody } from "../../webhooks/limited-body.ts";
import { resourceMetadataUrl } from "../oauth/metadata.ts";
import type { OAuthService, Principal } from "../oauth/service.ts";
import { scopeSatisfies } from "../scopes.ts";
import { actorOf, type ToolContext } from "../tools/context.ts";
import { createToolServices, sessionUserOf } from "../tools/services.ts";
import type { ToolRegistry } from "../tools/registry.ts";

export const MCP_BODY_MAX_BYTES = 1024 * 1024;
export const SERVER_NAME = "software-factory";
export const SERVER_VERSION = "1.0.0";
export const SERVER_INSTRUCTIONS =
  "Controls a Software Factory workspace. Call whoami, then describe_factory; call get_lane_schema before you write a lane. Every tool works in the one workspace this connection was approved for, within the approved scope and the person's role. A failed tool returns isError with a stable `error` code.";

export type McpEndpointDependencies = {
  service: Pick<OAuthService, "authenticate">;
  registry: ToolRegistry;
  baseUrl: string;
  environment: { productName: string; capabilities: readonly string[] };
  /** The database the services of a tool use, opened only when a tool asks (`context.services`). */
  database: () => Kysely<Database>;
  now?: () => Date;
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "www-authenticate",
  "access-control-max-age": "86400",
};

const JSON_RPC_PARSE_ERROR = {
  jsonrpc: "2.0",
  error: { code: -32700, message: "Parse error" },
  id: null,
};

function withHeaders(
  response: Response,
  extra: Record<string, string>,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

/** The bearer token of the Authorization header, or null. The scheme is case insensitive (RFC 9110). */
export function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^bearer +([^ ]+)$/i.exec(header.trim());
  return match === null ? null : (match[1] as string);
}

export function createMcpEndpoint({
  service,
  registry,
  baseUrl,
  environment,
  database,
  now = () => new Date(),
}: McpEndpointDependencies) {
  const metadata = resourceMetadataUrl(baseUrl);

  function challenge(parts: string[]): string {
    return [
      "Bearer",
      [...parts, `resource_metadata="${metadata}"`].join(", "),
    ].join(" ");
  }

  function unauthorized(
    problem: { error: string; description: string } | null,
  ): Response {
    const parts =
      problem === null
        ? ['scope="factory:read"']
        : [
            `error="${problem.error}"`,
            `error_description="${problem.description}"`,
          ];
    return Response.json(
      problem === null
        ? {
            error: "unauthorized",
            message: "Send an access token: Authorization: Bearer <token>.",
          }
        : { error: problem.error, message: problem.description },
      {
        status: 401,
        headers: {
          ...CORS,
          "cache-control": "no-store",
          "www-authenticate": challenge(parts),
        },
      },
    );
  }

  function insufficientScope(needed: string, name: string): Response {
    return Response.json(
      {
        error: "insufficient_scope",
        message: `The tool ${name} needs the scope ${needed}. Connect again and approve ${needed}.`,
        requiredScope: needed,
      },
      {
        status: 403,
        headers: {
          ...CORS,
          "cache-control": "no-store",
          "www-authenticate": challenge([
            'error="insufficient_scope"',
            `scope="${needed}"`,
            'error_description="The token does not carry the scope this tool needs."',
          ]),
        },
      },
    );
  }

  function contextOf(principal: Principal): ToolContext {
    const actor = actorOf(principal);
    const access = {
      user: sessionUserOf(principal.user),
      workspace: principal.workspaceRecord,
      role: principal.role,
    };
    return {
      user: principal.user,
      workspace: principal.workspace,
      role: principal.role,
      scopes: principal.scopes,
      client: principal.client,
      actor,
      access,
      services: createToolServices({ access, actor, database }),
      connectedAt: principal.connectedAt,
      accessTokenExpiresAt: principal.tokenExpiresAt,
      environment: { ...environment, baseUrl },
      tools: registry.summaries(),
      now,
    };
  }

  /** The server of one request: `tools/list` and `tools/call`, nothing else. */
  function serverFor(principal: Principal): Server {
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        capabilities: { tools: { listChanged: false } },
        instructions: SERVER_INSTRUCTIONS,
      },
    );
    const context = contextOf(principal);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: registry.listFor(principal.scopes).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: "object" },
        annotations: {
          title: tool.title,
          readOnlyHint: tool.scope === "factory:read",
        },
      })),
    }));
    server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> => {
        const outcome = await registry.call(
          request.params.name,
          context,
          request.params.arguments,
        );
        if (outcome.ok)
          return {
            content: [{ type: "text", text: JSON.stringify(outcome.data) }],
            structuredContent: outcome.data,
          };
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(outcome.failure) }],
          structuredContent: outcome.failure,
        };
      },
    );
    return server;
  }

  /** The first `tools/call` in the body that names a tool the scopes do not allow, if any. */
  function deniedCall(
    parsed: unknown,
    principal: Principal,
  ): { name: string; scope: string } | null {
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      if (typeof message !== "object" || message === null) continue;
      const { method, params } = message as {
        method?: unknown;
        params?: { name?: unknown };
      };
      if (method !== "tools/call" || typeof params?.name !== "string") continue;
      const tool = registry.get(params.name);
      if (tool !== undefined && !scopeSatisfies(principal.scopes, tool.scope))
        return { name: tool.name, scope: tool.scope };
    }
    return null;
  }

  return {
    async handle(request: Request): Promise<Response> {
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: CORS });

      const authenticated = await service.authenticate(bearerOf(request));
      if (authenticated.kind === "error")
        return unauthorized(
          authenticated.error === "invalid_request"
            ? null
            : {
                error: authenticated.error,
                description: authenticated.description,
              },
        );

      // Stateless: there is no stream to open and no session to end.
      if (request.method !== "POST")
        return Response.json(
          {
            error: "method_not_allowed",
            message: "Send MCP messages with POST.",
          },
          {
            status: 405,
            headers: {
              ...CORS,
              allow: "POST, OPTIONS",
              "cache-control": "no-store",
            },
          },
        );

      const body = await readLimitedBody(request, MCP_BODY_MAX_BYTES);
      if (!body.ok)
        return Response.json(
          {
            jsonrpc: "2.0",
            error: { code: -32600, message: "The request is too large." },
            id: null,
          },
          { status: 413, headers: { ...CORS, "cache-control": "no-store" } },
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        return Response.json(JSON_RPC_PARSE_ERROR, {
          status: 400,
          headers: { ...CORS, "cache-control": "no-store" },
        });
      }

      const denied = deniedCall(parsed, authenticated.principal);
      if (denied !== null) {
        registry.audit(
          contextOf(authenticated.principal),
          denied.name,
          "insufficient_scope",
        );
        return insufficientScope(denied.scope, denied.name);
      }

      const server = serverFor(authenticated.principal);
      const transport = new WebStandardStreamableHTTPServerTransport({
        // No session: every request stands alone.
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        const response = await transport.handleRequest(request, {
          parsedBody: parsed,
        });
        return withHeaders(response, { ...CORS, "cache-control": "no-store" });
      } finally {
        await server.close().catch(() => undefined);
      }
    },
  };
}
