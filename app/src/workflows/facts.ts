// SPDX-License-Identifier: LicenseRef-Proprietary

// The facts every agent step yields without the agent reporting them (#833; plan: "Facts Control knows are always part of the
// result"): what the platform saw, not what the agent said. The cost is always there. The branch and the commits exist only if the
// profile may push: a run without the right to push has none, and a workflow that uses them is refused.
import {
  BOOLEAN,
  NUMBER,
  STRING,
  listOf,
  objectOf,
  type ValueType,
} from "./value-type.ts";

export const COST_FACT = "costUsd";
export const PUSH_FACTS = [
  "branch",
  "commits",
  "headCommit",
  "pushed",
] as const;
export const FACT_NAMES: readonly string[] = [COST_FACT, ...PUSH_FACTS];

export const FACT_TYPES: Record<string, ValueType> = {
  costUsd: NUMBER,
  branch: STRING,
  /** The commit ids the step made, oldest first. */
  commits: listOf(STRING),
  /** The last commit of the branch when the turn ended; the commit the branch started from when the agent made none. */
  headCommit: STRING,
  /** Whether the branch reached the remote. */
  pushed: BOOLEAN,
};

/**
 * #1092 (epic #1090, ADR 0006): the fact of a step with `repos` (and of a step that continues the session of one), a list with one entry per
 * repository, in the order of the step. Not one of `FACT_NAMES`: a lane that has a result field `repos` today keeps it, and only a step with
 * `repos` reserves the name (`result_field_reserved`). Like the push facts it exists only for a profile that may push.
 */
export const REPOS_FACT = "repos";

/** One entry of `{{<step>.repos}}`: the repository, its base and working branch, the commits this turn made on it, its tip and whether it is on the remote. */
export const REPOS_FACT_ENTRY_TYPE = objectOf({
  fullName: STRING,
  base: STRING,
  branch: STRING,
  commits: listOf(STRING),
  headCommit: STRING,
  pushed: BOOLEAN,
});
export const REPOS_FACT_TYPE: ValueType = listOf(REPOS_FACT_ENTRY_TYPE);
