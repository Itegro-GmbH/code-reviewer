// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Worker API's MCP route reads of a request (#1053): the method, the one JSON-RPC message of a POST (bounded), and the two MCP headers.
// Nothing else of the request goes on: not `Authorization` (that is the job's credential), not a cookie, not an address.
import {
  MCP_PROXY_MAX_REQUEST_BYTES,
  type McpProxyRequest,
} from "../mcp/proxy.ts";
import { mcpRefusal } from "../mcp/refusal.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";

/** A server id is a UUID (`mcp_servers.id`). */
export const MCP_SERVER_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The answer for a server that is not the job's, does not exist, or a deployment without MCP: one answer for all. */
export function mcpUnavailable(): Response {
  return mcpRefusal("mcp_server_unavailable");
}

export type McpCall =
  | "method_not_allowed"
  | {
      read(): Promise<{ ok: true; request: McpProxyRequest } | { ok: false }>;
    };

export function mcpCallOf(request: Request): McpCall {
  const method = request.method;
  // A GET is the stream of the server's own, which the app does not offer (the specification allows a 405): answered before anything is
  // looked up, counted or unsealed.
  if (method !== "POST" && method !== "DELETE") return "method_not_allowed";
  const sessionId = request.headers.get("mcp-session-id");
  const protocolVersion = request.headers.get("mcp-protocol-version");
  return {
    async read() {
      if (method === "DELETE") {
        await request.body?.cancel().catch(() => undefined);
        return {
          ok: true,
          request: { method, body: null, sessionId, protocolVersion },
        };
      }
      const body = await readLimitedBody(request, MCP_PROXY_MAX_REQUEST_BYTES);
      if (!body.ok) return { ok: false };
      return {
        ok: true,
        request: { method, body: body.text, sessionId, protocolVersion },
      };
    },
  };
}
