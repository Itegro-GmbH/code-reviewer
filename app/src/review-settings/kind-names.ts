// SPDX-License-Identifier: LicenseRef-Proprietary

// What the two review kinds are called to a person. The settings form and the Runs pages use the same
// names, so a run reads as the kind the project chose.
import type { JobKind, ProjectReviewKind } from "../job-kind/job-kind.ts";

export const KIND_NAMES: Record<ProjectReviewKind, string> = {
  diff: "Diff Review",
  dynamic: "Dynamic Review",
};

/** The same for every kind a job can have (#752): the Runs pages show runs of all of them; a project chooses only the two above. */
export const JOB_KIND_NAMES: Record<JobKind, string> = {
  ...KIND_NAMES,
  implementer: "Implementer",
};
