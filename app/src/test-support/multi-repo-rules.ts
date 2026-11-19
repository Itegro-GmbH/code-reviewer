// SPDX-License-Identifier: LicenseRef-Proprietary

// #1091 (epic #1090, ADR 0006): what the shared negative corpus (contracts/examples/implementer-multi-repo/invalid/) needs to be read: a
// document edited by key and an RFC 6902 patch. The rules themselves are the app's real code since #1092: the lane rules are the validator's
// (`workflows/check-steps.ts`) and the job rules are the claim's own check of the job it builds (`runner-api/multi-repo-job.ts`); the runner's
// parser holds the same list (the Python reference of its contract test is runner/tests/contract/multi_repo_rules.py).

/** A JSON document edited by key. */
export type Document = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON document edited by key in a test

function pointer(path: string): string[] {
  return path
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** A minimal RFC 6902 patch (add, replace, remove; `-` appends) of a copy of `document`. */
export function applyPatch(
  document: Document,
  patch: ReadonlyArray<{ op: string; path: string; value?: unknown }>,
): Document {
  const result = structuredClone(document);
  for (const { op, path, value } of patch) {
    const keys = pointer(path);
    const last = keys.pop() as string;
    let parent: any = result; // eslint-disable-line @typescript-eslint/no-explicit-any -- walks a JSON document by pointer
    for (const key of keys) parent = parent[key];
    if (Array.isArray(parent)) {
      const index = last === "-" ? parent.length : Number(last);
      if (op === "add") parent.splice(index, 0, value);
      else if (op === "replace") parent[index] = value;
      else if (op === "remove") parent.splice(index, 1);
      else throw new Error(`unknown patch operation ${op}`);
    } else if (op === "remove") delete parent[last];
    else if (op === "add" || op === "replace") parent[last] = value;
    else throw new Error(`unknown patch operation ${op}`);
  }
  return result;
}
