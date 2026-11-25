// SPDX-License-Identifier: LicenseRef-Proprietary

// `edits` of `update_lane` (#1145): changes to a lane document as JSON pointers (RFC 6901), applied to a copy. The result is NOT trusted: the
// lane service validates it like any document, so an edit can only produce what a whole `document` could.
import { ToolError } from "../errors.ts";

export type LaneEdit = { path: string; value?: unknown };

const isContainer = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

function segments(path: string): string[] {
  if (!path.startsWith("/"))
    throw new ToolError(
      "invalid_input",
      `The path "${path.slice(0, 60)}" is not a JSON pointer: it starts with "/".`,
    );
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

function indexOf(list: unknown[], part: string, path: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(part) || Number(part) > list.length)
    throw new ToolError(
      "invalid_input",
      `The path "${path.slice(0, 60)}" does not fit the document: "${part.slice(0, 30)}" is no index of its array.`,
    );
  return Number(part);
}

/** Applies the edits in order to a copy of `document` and returns it as an object. */
export function applyEdits(
  document: unknown,
  edits: readonly LaneEdit[],
): Record<string, unknown> {
  const copy = structuredClone(document);
  if (!isContainer(copy) || Array.isArray(copy))
    throw new ToolError("internal_error", "The stored lane is not an object.");
  for (const edit of edits) {
    const parts = segments(edit.path);
    const last = parts.pop();
    if (last === undefined || (parts.length === 0 && last === ""))
      throw new ToolError(
        "invalid_input",
        "Give a path below the root; to replace the whole lane send `document`.",
      );
    let parent: unknown = copy;
    for (const part of parts) {
      if (FORBIDDEN.has(part))
        throw new ToolError("invalid_input", "That path is not allowed.");
      const next: unknown = Array.isArray(parent)
        ? parent[indexOf(parent, part, edit.path)]
        : isContainer(parent) && Object.hasOwn(parent, part)
          ? (parent as Record<string, unknown>)[part]
          : undefined;
      if (!isContainer(next))
        throw new ToolError(
          "invalid_input",
          `The path "${edit.path.slice(0, 60)}" does not exist in the lane: nothing at "${part.slice(0, 30)}".`,
        );
      parent = next;
    }
    if (FORBIDDEN.has(last))
      throw new ToolError("invalid_input", "That path is not allowed.");
    if (Array.isArray(parent)) {
      const at =
        last === "-" ? parent.length : indexOf(parent, last, edit.path);
      if (edit.value === undefined) parent.splice(at, 1);
      else if (last === "-" || at === parent.length) parent.push(edit.value);
      else parent[at] = edit.value;
    } else if (isContainer(parent)) {
      if (edit.value === undefined)
        delete (parent as Record<string, unknown>)[last];
      else (parent as Record<string, unknown>)[last] = edit.value;
    }
  }
  return copy as Record<string, unknown>;
}
