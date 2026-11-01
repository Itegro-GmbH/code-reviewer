// SPDX-License-Identifier: LicenseRef-Proprietary

// The claim guard of the running server: a review runs only while its repository has an active project.
// The webhook route already ignores triggers of repositories without one; this closes the gap for a
// job that was queued while the project was on and is claimed after it was switched off (and for a
// deactivation that raced with the claim). Asking the project service at claim time, not at enqueue
// time, is what makes the answer current.
import type { JobErrorCode } from "../jobs/job-types.ts";
import type { ProjectService } from "../projects/service.ts";
import type { ClaimGuard } from "./claim-guard.ts";

/** The error code of a job that is dropped because its project is off. */
export const PROJECT_DEACTIVATED = "project_deactivated" satisfies JobErrorCode;

export function createProjectClaimGuard(deps: {
  /** The project service of the workspace the claimed job belongs to (`job.workspaceId`). */
  projects: (
    workspaceId: string,
  ) => Pick<ProjectService, "getActiveProjectForRepository">;
}): ClaimGuard {
  return {
    async check(job) {
      // A task of the Implementer is not a review: it works on a repository of the workspace without a project (the form lists
      // those, #755), and a deactivated project does not cancel it either (`cancelWaiting` leaves it alone, #752).
      if (job.reviewKind === "implementer") return { allow: true };
      const project = await deps
        .projects(job.workspaceId)
        .getActiveProjectForRepository(job.repositoryId);
      if (project !== undefined) return { allow: true };
      // Cancelled, not failed: the job did nothing wrong, and so are the other jobs of the repository.
      return {
        allow: false,
        errorCode: PROJECT_DEACTIVATED,
        outcome: "cancel",
      };
    },
  };
}
