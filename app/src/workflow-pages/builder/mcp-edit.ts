// SPDX-License-Identifier: LicenseRef-Proprietary

// What the lane card and the inspector of an agent step write into the document for MCP servers (#1052). Plain immutable edits of the
// document, like `document.ts`; the validator decides whether the result is valid. The lists hold server ids; the pickers show names.
import { isRecord } from "../../workflows/json.ts";
import type { McpEntry } from "./mcp-picker.tsx";
import { laneMcpServers } from "../../workflows/mcp.ts";
import { nodeAt, segmentsOf, type Doc } from "./document.ts";

/** An MCP server of the workspace as the pickers offer it. */
export type McpServerOption = {
  id: string;
  name: string;
  /** The result of the last connection test: `failed` is shown as broken. */
  status: "untested" | "ok" | "failed";
};

const CHILD_LISTS = ["then", "else", "body"] as const;

function textsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
}

/** The steps of a list with `change` applied to every agent step's own list, inside `if`, loops and the pre-steps of triggers. */
function mapAgents(
  entries: unknown,
  change: (list: string[]) => string[],
): unknown {
  if (!Array.isArray(entries)) return entries;
  return (entries as unknown[]).map((entry) => {
    if (!isRecord(entry)) return entry;
    const next: Doc = { ...entry };
    if (entry.kind === "agent" && Array.isArray(entry.mcp))
      next.mcp = change(textsOf(entry.mcp));
    if (entry.steps !== undefined) next.steps = mapAgents(entry.steps, change);
    for (const key of CHILD_LISTS)
      if (entry[key] !== undefined) next[key] = mapAgents(entry[key], change);
    return next;
  });
}

/**
 * The lane names `id` (`on`) or does not any more. A server the lane drops is taken out of every step's own list too, so no step names
 * what its lane does not (a step with an empty list keeps it: none stays none). The key is removed when the lane names nothing.
 */
export function withLaneServer(doc: Doc, id: string, on: boolean): Doc {
  const current = laneMcpServers(doc);
  const list = on
    ? current.includes(id)
      ? current
      : [...current, id]
    : current.filter((entry) => entry !== id);
  const next: Doc = { ...doc };
  if (list.length === 0) delete next.mcp;
  else next.mcp = list;
  if (on) return next;
  const narrowed = (entries: unknown) =>
    mapAgents(entries, (own) => own.filter((entry) => entry !== id));
  if (doc.triggers !== undefined) next.triggers = narrowed(doc.triggers);
  if (doc.steps !== undefined) next.steps = narrowed(doc.steps);
  if (doc.onFailure !== undefined) next.onFailure = narrowed(doc.onFailure);
  return next;
}

/** A step's own list; undefined while it follows the lane (no `mcp`). A value that is no list is an empty one. */
export function stepServers(node: Doc): string[] | undefined {
  return node.mcp === undefined ? undefined : textsOf(node.mcp);
}

/**
 * The step at `pointer` may use `id` (`on`) or may not. The step starts from its own list, or from all of the lane's while it has none.
 * A list that holds every server of the lane (and nothing else) is the lane's own list again: the key is removed, so the step follows
 * the lane when the lane gains a server.
 */
export function withStepServer(
  doc: Doc,
  pointer: string,
  lane: readonly string[],
  id: string,
  on: boolean,
): Doc {
  const node = nodeAt(doc, pointer);
  if (node === undefined) return doc;
  const base = stepServers(node) ?? [...lane];
  const wanted = on
    ? base.includes(id)
      ? base
      : [...base, id]
    : base.filter((entry) => entry !== id);
  // The lane's servers in the lane's order, then what the lane does not have (it can be taken out, never added here).
  const list = [
    ...lane.filter((entry) => wanted.includes(entry)),
    ...wanted.filter((entry) => !lane.includes(entry)),
  ];
  const followsLane =
    lane.length > 0 &&
    list.length === lane.length &&
    lane.every((entry) => list.includes(entry));
  return withNodeList(doc, pointer, followsLane ? undefined : list);
}

/** The document with `mcp` of the node at `pointer` set to `list`, or removed for `undefined`. */
function withNodeList(
  doc: Doc,
  pointer: string,
  list: string[] | undefined,
): Doc {
  const segments = segmentsOf(pointer);
  const walk = (current: unknown, rest: readonly string[]): unknown => {
    const [head, ...tail] = rest;
    if (head === undefined) {
      const copy: Doc = isRecord(current) ? { ...current } : {};
      if (list === undefined) delete copy.mcp;
      else copy.mcp = list;
      return copy;
    }
    if (Array.isArray(current)) {
      const copy = [...(current as unknown[])];
      copy[Number(head)] = walk(copy[Number(head)], tail);
      return copy;
    }
    const record = isRecord(current) ? current : {};
    return { ...record, [head]: walk(record[head], tail) };
  };
  return walk(doc, segments) as Doc;
}

/** The entries of the lane card: every server of the workspace, then the ones the lane names that the workspace no longer has. */
export function laneMcpEntries(
  doc: Doc,
  servers: readonly McpServerOption[],
): McpEntry[] {
  const named = laneMcpServers(doc);
  const known = new Set(servers.map((server) => server.id));
  return [
    ...servers.map((server): McpEntry => ({
      id: server.id,
      name: server.name,
      state: server.status,
      checked: named.includes(server.id),
    })),
    ...named
      .filter((id) => !known.has(id))
      .map((id): McpEntry => ({
        id,
        name: id,
        state: "missing",
        checked: true,
      })),
  ];
}

/**
 * The entries of the inspector of an agent step: the lane's servers (checked while the step follows the lane, else when its own list has
 * them), then the ones the step names that its lane does not. Empty when neither the lane nor the step names any.
 */
export function stepMcpEntries(
  doc: Doc,
  node: Doc,
  servers: readonly McpServerOption[],
): McpEntry[] {
  const lane = laneMcpServers(doc);
  const own = stepServers(node);
  const byId = new Map(servers.map((server) => [server.id, server]));
  const entryOf = (id: string, outside: boolean): McpEntry => {
    const server = byId.get(id);
    return {
      id,
      name: server?.name ?? id,
      state:
        server === undefined ? "missing" : outside ? "outside" : server.status,
      checked: outside ? true : own === undefined || own.includes(id),
    };
  };
  return [
    ...lane.map((id) => entryOf(id, false)),
    ...(own ?? [])
      .filter((id) => !lane.includes(id))
      .map((id) => entryOf(id, true)),
  ];
}
