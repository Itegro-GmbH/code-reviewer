// SPDX-License-Identifier: LicenseRef-Proprietary

// How the list of MCP calls is kept on the page (#1055): the calls come in pages that follow a cursor, in the order they were written in. A call
// is final when it is written (it has no later state), so a page that arrives twice or late changes nothing. Pure.
import type { McpCallView } from "../mcp-calls-view.ts";

/** `existing` with `incoming` merged in: a call is kept once, by its `seq`, and the result is in the order of `seq`. */
export function mergeMcpCalls(
  existing: readonly McpCallView[],
  incoming: readonly McpCallView[],
): McpCallView[] {
  if (incoming.length === 0) return [...existing];
  const bySeq = new Map<number, McpCallView>();
  for (const call of existing) bySeq.set(call.seq, call);
  for (const call of incoming)
    if (!bySeq.has(call.seq)) bySeq.set(call.seq, call);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** How many calls the page shows at first, and how many more each click on "earlier" adds. */
export const RENDER_CALLS = 200;
