// SPDX-License-Identifier: LicenseRef-Proprietary

// What the repository list of an agent step writes into the document (#1094, epic #1090): plain immutable edits, like `mcp-edit.ts`. The
// validator decides whether the result is valid (`repos_with_branch`, `repo_duplicate`, the targets).
import { isRecord } from "../../workflows/json.ts";
import { SESSION_REPOS_MAX } from "../../db/session-repos.ts";
import { patchNode, type Doc, type Pointer } from "./document.ts";

export { SESSION_REPOS_MAX };

/** One entry of `repos` as the editor shows it: every field as the text in the document ("" for one that is left out). */
export type RepoEntry = { repo: string; base: string; branch: string };

const textOf = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** The entries of the step's `repos`; a list that is not one (a hand-written document) shows no entries and is left alone until an edit. */
export function repoEntries(node: Doc): RepoEntry[] {
  if (!Array.isArray(node.repos)) return [];
  return (node.repos as unknown[]).map((entry) =>
    isRecord(entry)
      ? {
          repo: textOf(entry.repo),
          base: textOf(entry.base),
          branch: textOf(entry.branch),
        }
      : { repo: "", base: "", branch: "" },
  );
}

/** The entry as the document keeps it: a field left empty is left out, and so is the whole of `repo` only when it was typed empty (the validator then asks for it). */
function entryOf(entry: RepoEntry): Doc {
  return {
    repo: entry.repo,
    ...(entry.base === "" ? {} : { base: entry.base }),
    ...(entry.branch === "" ? {} : { branch: entry.branch }),
  };
}

/** The step with this list of entries; an empty list takes `repos` out (a step without it is the step of today). */
export function withRepoEntries(
  doc: Doc,
  pointer: Pointer,
  entries: readonly RepoEntry[],
): Doc {
  return patchNode(doc, pointer, {
    repos: entries.length === 0 ? undefined : entries.map(entryOf),
  });
}

export function addRepoEntry(
  doc: Doc,
  pointer: Pointer,
  entries: readonly RepoEntry[],
): Doc {
  if (entries.length >= SESSION_REPOS_MAX) return doc;
  return withRepoEntries(doc, pointer, [
    ...entries,
    { repo: "", base: "", branch: "" },
  ]);
}

export function changeRepoEntry(
  doc: Doc,
  pointer: Pointer,
  entries: readonly RepoEntry[],
  index: number,
  change: Partial<RepoEntry>,
): Doc {
  return withRepoEntries(
    doc,
    pointer,
    entries.map((entry, at) =>
      at === index ? { ...entry, ...change } : entry,
    ),
  );
}

export function removeRepoEntry(
  doc: Doc,
  pointer: Pointer,
  entries: readonly RepoEntry[],
  index: number,
): Doc {
  return withRepoEntries(
    doc,
    pointer,
    entries.filter((_, at) => at !== index),
  );
}
