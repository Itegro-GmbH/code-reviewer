// SPDX-License-Identifier: LicenseRef-Proprietary

// What the validator found, put where it belongs in the flow (#926): an error's `path` is a JSON pointer into the document, and the node
// it belongs to is the deepest step or trigger that pointer runs through. Errors that are about the document as a whole (the name, the
// budget, the number of steps) belong to no node and show in the header. A one-click fix exists only where the validator named exactly
// one name that would do (`available`) and the value at `path` is a plain text to be swapped for it: nothing is guessed.
import type { Issue } from "../../workflows/issues.ts";
import { getAt, type Doc, type Pointer } from "./document.ts";

export type Problem = Pick<Issue, "path" | "message"> & {
  /** A code the validator or the save route gave; the builder shows it as it is and branches on none but the fixable ones. */
  code: string;
  available?: string[];
};

const NODE_PREFIX =
  /^(?:\/triggers\/\d+(?:\/steps\/\d+)?|\/steps\/\d+|\/onFailure\/\d+)(?:\/(?:body|then|else)\/\d+)*/;

/** The node an error path belongs to, or undefined when it is about the document itself. */
export function nodeOfPath(path: string): Pointer | undefined {
  return NODE_PREFIX.exec(path)?.[0];
}

export type SortedProblems = {
  byNode: Map<Pointer, Problem[]>;
  /** Not about any node. */
  document: Problem[];
};

export function sortProblems(problems: readonly Problem[]): SortedProblems {
  const byNode = new Map<Pointer, Problem[]>();
  const document: Problem[] = [];
  for (const problem of problems) {
    const node = nodeOfPath(problem.path);
    if (node === undefined) {
      document.push(problem);
      continue;
    }
    const list = byNode.get(node);
    if (list === undefined) byNode.set(node, [problem]);
    else list.push(problem);
  }
  return { byNode, document };
}

/** How many problems a node itself has (what its red count shows); a loop or `if` does not count what is inside it. */
export function countOf(sorted: SortedProblems, node: Pointer): number {
  return sorted.byNode.get(node)?.length ?? 0;
}

const FIXABLE_CODES = [
  "profile_unknown",
  "profile_archived",
  "profile_version_unknown",
  "environment_unknown",
  "unknown_connector",
  "unknown_trigger_kind",
  "session_target_invalid",
] as const;

export type Fix = {
  pointer: Pointer;
  value: string;
  /** What the button says: the replacement. */
  replacement: string;
};

/** The one-click fix of a problem, when its `available` has exactly one name and the value at `path` is a text. */
export function fixOf(doc: Doc, problem: Problem): Fix | undefined {
  if (!(FIXABLE_CODES as readonly string[]).includes(problem.code))
    return undefined;
  const [only, ...more] = problem.available ?? [];
  if (only === undefined || more.length > 0 || only.endsWith("…"))
    return undefined;
  const current = getAt(doc, problem.path);
  if (typeof current !== "string") return undefined;
  const value =
    problem.code === "profile_version_unknown"
      ? `${current.split("@")[0] ?? ""}@${only}`
      : only;
  return { pointer: problem.path, value, replacement: value };
}
