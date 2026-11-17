// SPDX-License-Identifier: LicenseRef-Proprietary

// What the run's trace keeps of an MCP call (#1055, epic #1049), made from the call's metadata (`McpCallMeta` of the proxy) or from a refusal
// that happened before the proxy. The record has a field for the server, the method, the name of a tool, the status, the outcome, the duration
// and the sizes: no field for an argument, an answer, a header or an address, so none can be stored by mistake.
//
// The method and the tool come from the agent and the name of the server from a person: they are cleaned and cut once more here (the proxy
// did it for the tool and the method), so no trace row can carry a line break, a control character or a text of any length.
import type { McpCallRecord } from "../db/repositories/job-mcp-calls-repository.ts";
import { cleanText } from "./client.ts";
import type { McpCallMeta } from "./proxy.ts";
import { MCP_ROUTE_REFUSALS, type McpRouteRefusal } from "./refusal.ts";

export const SERVER_NAME_MAX_LENGTH = 200;
const TOOL_MAX_LENGTH = 100;
const METHOD_MAX_LENGTH = 100;

const text = (value: string, max: number): string =>
  cleanText(value).slice(0, max);

const optionalText = (value: string | null, max: number): string | null =>
  value === null ? null : text(value, max);

/** A count for a column that refuses a negative number: a whole number, 0 for anything else. */
function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function recordOfMeta(meta: McpCallMeta): McpCallRecord {
  return {
    serverId: meta.serverId,
    serverName: text(meta.serverName, SERVER_NAME_MAX_LENGTH),
    rpcMethod: optionalText(meta.rpcMethod, METHOD_MAX_LENGTH),
    tool: optionalText(meta.tool, TOOL_MAX_LENGTH),
    status: meta.status,
    outcome: meta.outcome,
    durationMs: count(meta.durationMs),
    requestBytes: count(meta.requestBytes),
    responseBytes: count(meta.responseBytes),
  };
}

/** The method and the tool name of the one JSON-RPC message of a body, cleaned and cut; nothing for a body that is not one. Never throws. */
export function peekCall(body: string | null): {
  rpcMethod: string | null;
  tool: string | null;
} {
  const none = { rpcMethod: null, tool: null };
  if (body === null || body === "") return none;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return none;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return none;
  const message = value as { method?: unknown; params?: unknown };
  if (typeof message.method !== "string" || message.method === "") return none;
  const params =
    typeof message.params === "object" &&
    message.params !== null &&
    !Array.isArray(message.params)
      ? (message.params as { name?: unknown })
      : {};
  return {
    rpcMethod: text(message.method, METHOD_MAX_LENGTH),
    tool:
      message.method === "tools/call" && typeof params.name === "string"
        ? text(params.name, TOOL_MAX_LENGTH)
        : null,
  };
}

/**
 * A call that was refused before it reached the proxy (or a limit of the route): the status and the code the agent's side got. The call was not
 * made, so it took no time and got no answer; `serverName` is empty where the server was not looked up (a limit, or a server that is not the step's).
 */
export function recordOfRefusal(input: {
  serverId: string;
  serverName?: string;
  code: McpRouteRefusal;
  /** The body of the request, if it was read: only its method and the tool name are kept. */
  body: string | null;
}): McpCallRecord {
  const { rpcMethod, tool } = peekCall(input.body);
  return {
    serverId: input.serverId,
    serverName: text(input.serverName ?? "", SERVER_NAME_MAX_LENGTH),
    rpcMethod,
    tool,
    status: MCP_ROUTE_REFUSALS[input.code],
    outcome: input.code,
    durationMs: 0,
    requestBytes:
      input.body === null ? 0 : Buffer.byteLength(input.body, "utf8"),
    responseBytes: 0,
  };
}
