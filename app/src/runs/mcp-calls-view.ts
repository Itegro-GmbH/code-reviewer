// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Runs page reads of the MCP calls of a run of the Implementer (#1055, epic #1049): one entry for each call the agent made through the
// MCP proxy, or each refusal of one, as plain text and numbers: the server and its name, the method, the name of a tool, the duration, the sizes
// and how it ended. Never an argument or an answer: neither is stored, and the view has no field for them. Shared by the route that answers
// (`mcp-calls-service.ts`) and the list that shows them, so it imports nothing server-only.

/**
 * How a call ended, as the page groups it: `ok`; `cancelled` (the agent let go of an answer that was still arriving); `refused` (the app did
 * not call the server: the server is not the step's, a limit, a credential that cannot be used); `failed` (the call was made or tried and
 * went wrong: the server's answer, a timeout, no connection).
 */
export const MCP_CALL_RESULTS = [
  "ok",
  "cancelled",
  "refused",
  "failed",
] as const;
export type McpCallResult = (typeof MCP_CALL_RESULTS)[number];

/** The codes that mean the app refused the call before it reached the server (`MCP_ROUTE_REFUSALS`, `docs/mcp-runtime.md`). */
const REFUSED = [
  "mcp_server_unavailable",
  "mcp_proxy_request_too_large",
  "mcp_call_limit_reached",
  "mcp_too_many_concurrent_calls",
  "mcp_credential_broken",
  "mcp_credential_unsupported",
] as const;

/** The codes of a call that was made or tried and went wrong (`MCP_PROXY_ERROR_CODES`). */
const FAILED = [
  "mcp_proxy_request_invalid",
  "mcp_proxy_request_too_large",
  "mcp_proxy_address_refused",
  "mcp_proxy_unreachable",
  "mcp_proxy_timeout",
  "mcp_proxy_unauthorized",
  "mcp_proxy_http_error",
  "mcp_proxy_redirect_refused",
  "mcp_proxy_response_too_large",
  "mcp_proxy_protocol_error",
] as const;

/** The outcomes the page knows; any other text a row holds is shown as `unknown`, so no text of the row is ever used as a key. */
export type McpCallOutcome =
  | "ok"
  | "cancelled"
  | (typeof REFUSED)[number]
  | (typeof FAILED)[number]
  | "unknown";

const isOneOf = <T extends string>(
  list: readonly T[],
  value: string,
): value is T => (list as readonly string[]).includes(value);

/**
 * The outcome and the result group of a stored outcome code. `mcp_proxy_request_too_large` is a refusal at the route (before the proxy
 * read the body) and also the proxy's own code: both are a call that was not made, so it counts as refused.
 */
export function classifyOutcome(code: string): {
  outcome: McpCallOutcome;
  result: McpCallResult;
} {
  if (code === "ok") return { outcome: "ok", result: "ok" };
  if (code === "cancelled")
    return { outcome: "cancelled", result: "cancelled" };
  if (isOneOf(REFUSED, code)) return { outcome: code, result: "refused" };
  if (isOneOf(FAILED, code)) return { outcome: code, result: "failed" };
  return { outcome: "unknown", result: "failed" };
}

export type McpCallView = {
  /** Changes for each call; the cursor of the page is the highest one it has seen. */
  seq: number;
  serverId: string;
  /** The name of the server as it was at the call; empty where it was not looked up (the page shows the id then). */
  serverName: string;
  /** The JSON-RPC method (`tools/call`, …); null where none was read. */
  rpcMethod: string | null;
  /** The name of the tool of a `tools/call`; null otherwise. */
  tool: string | null;
  /** The HTTP status the agent's side got. */
  status: number;
  outcome: McpCallOutcome;
  result: McpCallResult;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  /** ISO 8601 in UTC, when the call was written down (the end of the call). */
  at: string;
};

/** The answer of `GET /api/w/:workspace/runs/:id/mcp-calls`. */
export type McpCallsSnapshot = {
  /** The calls after the `after` of the request, oldest first. */
  calls: McpCallView[];
  /** The highest `seq` of this answer, or the `after` of the request when nothing is new; the next request asks after it. */
  cursor: number;
  /** More calls wait behind this answer: ask again at once. */
  hasMore: boolean;
  /** The record of this run holds as many calls as it keeps at most: a call after the last one listed may not be listed. */
  full: boolean;
  /**
   * How many refusals "too many calls at once" were counted and not listed one by one: the record keeps the first few of a run (a loop can make
   * thousands, and they must not take the room of the real calls).
   */
  omitted: number;
};

/**
 * How many of the run's rows before its cursor an answer starts with. Rows of a job become visible when their transaction commits, which is not
 * always the order of their `seq` (four calls of a job run at once, on several instances): reading again a little behind the cursor finds the
 * one that came late, and the page keeps each `seq` once (`mcp-calls-merge.ts`).
 */
export const MCP_CALLS_OVERLAP_ROWS = 50;

/** How many calls one answer holds at most, and the default. */
export const MCP_CALLS_PAGE_LIMIT = 200;
