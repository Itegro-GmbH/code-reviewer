// SPDX-License-Identifier: LicenseRef-Proprietary

// The facts every agent step yields without the agent reporting them (#833; plan: "Facts Control knows are always part of the
// result"): what the platform saw, not what the agent said. The cost is always there. The branch and the commits exist only if the
// profile may push: a run without the right to push has none, and a workflow that uses them is refused.
import {
  BOOLEAN,
  NUMBER,
  STRING,
  listOf,
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
