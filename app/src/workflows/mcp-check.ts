// SPDX-License-Identifier: LicenseRef-Proprietary

// The checks of `mcp` on the lane and on an agent step (#1052): the form of the list, that the servers exist in this workspace, that a
// step names only servers its lane names, and a warning for a server whose last test failed. The resolver is the workspace's, so a server
// of another workspace is not there, and is reported exactly like one that never existed: the answer tells nothing about other workspaces.
import { jsonTypeName, textLength } from "./json.ts";
import {
  issue,
  listNames,
  pointer,
  shown,
  warning,
  type Issue,
} from "./issues.ts";
import { MCP_REF_MAX_LENGTH, MCP_REFS_MAX } from "./mcp.ts";
import type { WorkflowResolver } from "./resolver.ts";

type Report = (found: Issue) => void;

/** The entries of a list that are well formed texts, with their positions; a list with a wrong form is reported and yields what is usable. */
function checkForm(
  value: unknown,
  path: string,
  report: Report,
): { ref: string; at: number }[] | undefined {
  if (!Array.isArray(value)) {
    report(
      issue(
        path,
        "wrong_type",
        `'mcp' is a list of MCP server ids, not ${jsonTypeName(value)}.`,
      ),
    );
    return undefined;
  }
  if (value.length > MCP_REFS_MAX) {
    report(
      issue(
        path,
        "limit_exceeded",
        `'mcp' names ${MCP_REFS_MAX} servers at most; this list has ${value.length}.`,
      ),
    );
    return undefined;
  }
  const seen = new Set<string>();
  const usable: { ref: string; at: number }[] = [];
  (value as unknown[]).forEach((entry, at) => {
    const where = pointer(path, at);
    if (typeof entry !== "string") {
      report(
        issue(
          where,
          "wrong_type",
          `An entry of 'mcp' is the id of an MCP server (a text), not ${jsonTypeName(entry)}.`,
        ),
      );
      return;
    }
    if (textLength(entry) < 1 || textLength(entry) > MCP_REF_MAX_LENGTH) {
      report(
        issue(
          where,
          "invalid_value",
          `An entry of 'mcp' is the id of an MCP server: 1 to ${MCP_REF_MAX_LENGTH} characters.`,
        ),
      );
      return;
    }
    if (seen.has(entry)) {
      report(
        issue(
          where,
          "invalid_value",
          `The server ${shown(entry)} is named twice in this list.`,
        ),
      );
      return;
    }
    seen.add(entry);
    usable.push({ ref: entry, at });
  });
  return usable;
}

/**
 * `mcp` of the lane. Returns the servers it names (the ones a step may narrow to), whether or not they exist: a step that names one the
 * lane lists is not reported again for it.
 */
export function checkLaneMcp(
  value: unknown,
  resolver: WorkflowResolver,
  report: Report,
): ReadonlySet<string> {
  if (value === undefined) return new Set();
  const entries = checkForm(value, "/mcp", report);
  const named = new Set<string>();
  if (entries === undefined) return named;
  const servers = resolver.mcpServers?.() ?? [];
  for (const { ref, at } of entries) {
    named.add(ref);
    const found = servers.find((server) => server.id === ref);
    const where = pointer("/mcp", at);
    if (found === undefined) {
      report(
        issue(
          where,
          "mcp_server_unknown",
          `There is no MCP server ${shown(ref)} in this workspace. Name a server by its id. Servers: ${listNames(servers.map((server) => server.name))}.`,
          servers.map((server) => server.id),
        ),
      );
      continue;
    }
    if (found.status === "failed")
      report(
        warning(
          where,
          "mcp_server_broken",
          `The MCP server ${shown(found.name)} failed its last connection test. The lane can name it and save; a step that needs it may find it unreachable. Test it again on the MCP page.`,
        ),
      );
  }
  return named;
}

/** `mcp` of an agent step: a subset of the lane's list. Left out: all of the lane's; an empty list: none. */
export function checkStepMcp(
  node: Record<string, unknown>,
  path: string,
  lane: ReadonlySet<string>,
  report: Report,
): void {
  if (node.mcp === undefined) return;
  const where = pointer(path, "mcp");
  const entries = checkForm(node.mcp, where, report);
  if (entries === undefined) return;
  for (const { ref, at } of entries)
    if (!lane.has(ref))
      report(
        issue(
          pointer(where, at),
          "mcp_server_not_in_lane",
          `The step names the MCP server ${shown(ref)}, which the lane does not name. A step narrows the lane's list and never adds to it: add the server to 'mcp' of the lane, or take it out here.`,
          [...lane],
        ),
      );
}
