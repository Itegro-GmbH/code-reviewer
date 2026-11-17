// SPDX-License-Identifier: LicenseRef-Proprietary

// What the "MCP tool calls" section says (#1055): the heading, the words for how a call ended, and the notes. The names of servers and tools are
// not here: they come from people and from the agent, and are rendered as text.
import { MAX_MCP_CALLS_RECORDED_PER_JOB } from "../../db/mcp-call-limits.ts";
import type { McpCallOutcome, McpCallResult } from "../mcp-calls-view.ts";

export const MCP_CALLS_COPY = {
  title: "MCP tool calls",
  intro:
    "The calls the agent made to the MCP servers of this lane: which server, which tool, how long it took and how it ended. The arguments and the answers of a tool are not stored and not shown. Everyone in the workspace can read this.",
  logLabel: "MCP tool calls of the agent",
  failed:
    "The calls could not be updated. This page shows the calls it got; it keeps trying.",
  unknownServer: "unknown server",
  full: `This list holds the first ${new Intl.NumberFormat("en-US").format(MAX_MCP_CALLS_RECORDED_PER_JOB)} calls of the run; later ones are not listed.`,
} as const;

/** How a call ended, in words. Keyed by the closed set of outcomes the view knows (a Map: no property of an object is an outcome). */
const OUTCOME_TEXT = new Map<McpCallOutcome, string>([
  ["ok", "done"],
  ["cancelled", "cancelled by the agent"],
  ["mcp_server_unavailable", "not available to this step"],
  ["mcp_proxy_request_too_large", "request too large"],
  ["mcp_call_limit_reached", "call limit of the run reached"],
  ["mcp_too_many_concurrent_calls", "too many calls at once"],
  ["mcp_credential_broken", "credential cannot be used"],
  ["mcp_credential_unsupported", "credential kind not supported"],
  ["mcp_proxy_request_invalid", "not a valid request"],
  ["mcp_proxy_address_refused", "address not allowed"],
  ["mcp_proxy_unreachable", "server not reachable"],
  ["mcp_proxy_timeout", "timed out"],
  ["mcp_proxy_unauthorized", "server refused the credential"],
  ["mcp_proxy_http_error", "server answered with an error"],
  ["mcp_proxy_redirect_refused", "redirect refused"],
  ["mcp_proxy_response_too_large", "answer too large"],
  ["mcp_proxy_protocol_error", "server answered wrongly"],
  ["unknown", "ended with an error"],
]);

const RESULT_PREFIX = new Map<McpCallResult, string>([
  ["ok", ""],
  ["cancelled", ""],
  ["refused", "refused: "],
  ["failed", "failed: "],
]);

/** "refused: call limit of the run reached", "failed: timed out", "done". */
export function outcomeText(
  result: McpCallResult,
  outcome: McpCallOutcome,
): string {
  return `${RESULT_PREFIX.get(result) ?? ""}${OUTCOME_TEXT.get(outcome) ?? "ended with an error"}`;
}

/** "120 ms", "2.5 s", "1 min 05 s". */
export function callDurationText(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))} ms`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toString()} s`;
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60))} min ${String(seconds % 60).padStart(2, "0")} s`;
}

/** "Show earlier calls (50 hidden)". */
export function earlierCallsText(hidden: number): string {
  return `Show earlier calls (${hidden} hidden)`;
}
