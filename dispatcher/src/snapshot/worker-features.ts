// SPDX-License-Identifier: LicenseRef-Proprietary

// The features a Worker image lists (`WORKER_FEATURES` of runner/src/code_reviewer_runner/job_loop/worker_api.py), as they
// travel from the golden snapshot build to the Dispatcher (#1098): the build asks the image itself, the record and the snapshot
// pair carry the list (`SANDBOX_WORKER_FEATURES`, a comma separated list of names), and the Dispatcher names a claim feature
// that depends on the image only when the list of its active snapshot has it (`core/claim-features.ts`). Nothing in a list is
// secret, and a list is never trusted beyond its shape: anything malformed is the empty list (fail closed).

/** A feature name as the runner writes them: lower case words joined by underscores. */
const FEATURE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_FEATURES = 64;

/** What stands for the empty list where a variable must not be empty (a deployment variable, an Infisical secret). */
export const NO_FEATURES = "none";

/**
 * The list a value holds: a comma separated string (or an array of names), sorted and without duplicates. Absent, empty and
 * `none` are the empty list, and so is any value that has a name of another shape or more names than a Worker has: the
 * list of an old snapshot, or a value nobody can read, announces nothing.
 */
export function parseWorkerFeatures(value: unknown): string[] {
  let names: unknown[];
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "" || text === NO_FEATURES) return [];
    names = text.split(",").map((name) => name.trim());
  } else if (Array.isArray(value)) names = value as unknown[];
  else return [];
  if (names.length > MAX_FEATURES) return [];
  const list: string[] = [];
  for (const name of names) {
    if (typeof name !== "string" || !FEATURE.test(name)) return [];
    list.push(name);
  }
  return [...new Set(list)].sort();
}

/** The value to store for a list: the names joined by commas, `none` for the empty list. */
export function workerFeaturesValue(features: readonly string[]): string {
  const list = parseWorkerFeatures([...features]);
  return list.length === 0 ? NO_FEATURES : list.join(",");
}
