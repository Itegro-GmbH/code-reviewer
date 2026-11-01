// SPDX-License-Identifier: LicenseRef-Proprietary

// #195: the engines a runner can advertise and the review kinds each engine can run. A claim carries
// the engines of the calling runner (`contracts/runner-api.v1.json`, `ClaimRequest`); an empty legacy
// request means `pr-agent` only. The claim statement filters on the review kind, so a runner that
// cannot run a kind is never handed such a job — not even briefly, and without counting an attempt or
// creating credentials.
import type { JobKind } from "../job-kind/job-kind.ts";

/**
 * The engines a runner may claim for. `pr-agent` runs Diff Review, `opencode` runs Dynamic Review, `implementer` (#746) the
 * Implementer. The names are the enum of `Engine` in the contract; a test compares this list with the file.
 */
export const RUNNER_ENGINES = ["pr-agent", "opencode", "implementer"] as const;
export type RunnerEngine = (typeof RUNNER_ENGINES)[number];

/** The one engine a caller that sends no list (a previous-release runner) is trusted with. */
export const DEFAULT_ENGINES: readonly RunnerEngine[] = ["pr-agent"];

/** The review kinds one engine can run. */
export const REVIEW_KINDS_OF_ENGINE: Record<RunnerEngine, readonly JobKind[]> =
  {
    "pr-agent": ["diff"],
    opencode: ["dynamic"],
    // #752: the engine serves the turns of the Implementer and nothing else, and no other engine serves them: a runner without
    // the engine never selects one, and a runner with only this engine is never handed a Diff or Dynamic job.
    implementer: ["implementer"],
  };

/** Every kind the given engines together can run, without duplicates. */
export function reviewKindsForEngines(
  engines: readonly RunnerEngine[],
): JobKind[] {
  const kinds = new Set<JobKind>();
  for (const engine of engines)
    for (const kind of REVIEW_KINDS_OF_ENGINE[engine]) kinds.add(kind);
  return [...kinds];
}
