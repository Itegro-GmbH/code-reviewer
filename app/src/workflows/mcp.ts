// SPDX-License-Identifier: LicenseRef-Proprietary

// The MCP servers a lane and its agent steps may use (#1052, epic #1049), as the lane document says it. Pure: no database, no I/O.
//
// The shape (format v1, `contracts/workflow.v1.json`):
// - the lane (the document) has `mcp: [serverId, …]`: the servers of the workspace its agents may use. Left out: none. A lane without the
//   field is what every lane was before #1052, and what a built-in lane is.
// - an agent step may have `mcp: [serverId, …]`: a SUBSET of the lane's list. Left out: all of the lane's. An empty list: none.
//   A step never reaches a server its lane does not name; the validator refuses it (`mcp_server_not_in_lane`) and `effectiveMcpServersOfStep`
//   never grants one either.
// A server is named by its id (`mcp_servers.id`), not its name: a rename must not change what a lane may use. The key `mcp` is
// `MCP_LANE_DOCUMENT_KEY` (`src/mcp/lane-contract.test.ts`): removing a server is refused while a lane's document names it under that key.
//
// `effectiveMcpServers` is what the runtime (#1053) asks per agent step; the engine reads it from the run document
// (`workflow-runs/document.ts`).
import { isRecord } from "./json.ts";

/** At most this many servers in one list: the number of servers a workspace may hold (`MCP_SERVERS_MAX` in `src/mcp/service.ts`). */
export const MCP_REFS_MAX = 50;
/** A server id is a UUID (36 characters); a reference is never longer than a name. */
export const MCP_REF_MAX_LENGTH = 64;

/** The texts of a list, in order; undefined when the value is no list. Anything but a text is left out (a stored document passed the validator). */
function textsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return (value as unknown[]).filter(
    (entry): entry is string => typeof entry === "string",
  );
}

/** The servers the lane names; empty for a lane that names none (and for a document that is not one). */
export function laneMcpServers(document: unknown): string[] {
  return isRecord(document) ? (textsOf(document.mcp) ?? []) : [];
}

/**
 * The servers one agent step may use: its own list narrowed to the lane's (in the lane's order), all of the lane's when the step names
 * none (`mcp` left out), nothing when its list is empty. A step list that is no list grants nothing: a document the validator never saved
 * must not open a door.
 */
export function effectiveMcpServersOfStep(
  lane: readonly string[],
  step: Record<string, unknown>,
): string[] {
  if (step.mcp === undefined) return [...lane];
  const own = textsOf(step.mcp);
  if (own === undefined) return [];
  const wanted = new Set(own);
  return lane.filter((id) => wanted.has(id));
}

const CHILD_LISTS = ["then", "else", "body"] as const;

/** Every node of a document that is a list of steps below a trigger's `steps`, `steps` and `onFailure`, walked without recursion. */
function findStep(
  document: Record<string, unknown>,
  stepId: string,
): Record<string, unknown> | undefined {
  const pending: unknown[] = [];
  const triggers = Array.isArray(document.triggers)
    ? (document.triggers as unknown[])
    : [document.trigger];
  for (const trigger of triggers)
    if (isRecord(trigger) && Array.isArray(trigger.steps))
      pending.push(...(trigger.steps as unknown[]));
  if (Array.isArray(document.steps))
    pending.push(...(document.steps as unknown[]));
  if (Array.isArray(document.onFailure))
    pending.push(...(document.onFailure as unknown[]));
  // The walk is bounded by the size of a document the validator accepted; a document that is not one cannot loop it (a tree has no cycles).
  while (pending.length > 0) {
    const node = pending.shift();
    if (!isRecord(node)) continue;
    if (node.id === stepId) return node;
    for (const key of CHILD_LISTS)
      if (Array.isArray(node[key])) pending.push(...(node[key] as unknown[]));
  }
  return undefined;
}

/**
 * The servers the agent step `stepId` of a lane document may use. Nothing for a step that is not there or is not an agent step: the
 * answer for a lane that names no server is always the empty list.
 */
export function effectiveMcpServers(
  document: unknown,
  stepId: string,
): string[] {
  if (!isRecord(document)) return [];
  const lane = laneMcpServers(document);
  if (lane.length === 0) return [];
  const step = findStep(document, stepId);
  if (step === undefined || step.kind !== "agent") return [];
  return effectiveMcpServersOfStep(lane, step);
}
