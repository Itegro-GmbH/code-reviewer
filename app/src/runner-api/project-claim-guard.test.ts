// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the claim guard of the projects: an active project lets the job run, anything else cancels it.
import { describe, expect, it } from "vitest";
import type { Job } from "../jobs/job-types.ts";
import { createProjectClaimGuard } from "./project-claim-guard.ts";

const job = {
  id: "job-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
} as Job;

describe("the project claim guard", () => {
  // CR-46-T01
  it("allows a job whose repository has an active project", async () => {
    const asked: string[] = [];
    const guard = createProjectClaimGuard({
      projects: () => ({
        getActiveProjectForRepository: async (repositoryId) => {
          asked.push(repositoryId);
          return {} as never;
        },
      }),
    });

    expect(await guard.check(job)).toStrictEqual({ allow: true });
    expect(asked).toStrictEqual(["repo-1"]);
  });

  // CR-46-T01
  it("cancels a job whose repository has no active project", async () => {
    const guard = createProjectClaimGuard({
      projects: () => ({
        getActiveProjectForRepository: async () => undefined,
      }),
    });

    expect(await guard.check(job)).toStrictEqual({
      allow: false,
      errorCode: "project_deactivated",
      outcome: "cancel",
    });
  });

  // #767: found by the Implementer's journey in the privileged lane; the form offers a repository without a project (#755), and
  // every task on one was cancelled at the claim.
  it("lets a task of the Implementer run in a repository that has no project, and asks nothing of the projects", async () => {
    let asked = 0;
    const guard = createProjectClaimGuard({
      projects: () => ({
        getActiveProjectForRepository: async () => {
          asked += 1;
          return undefined;
        },
      }),
    });

    expect(
      await guard.check({ ...job, reviewKind: "implementer" } as Job),
    ).toStrictEqual({ allow: true });
    expect(asked).toBe(0);
    // A review of the same repository, of either kind, is still cancelled.
    for (const reviewKind of ["diff", "dynamic"] as const)
      expect(
        await guard.check({ ...job, reviewKind } as Job),
        reviewKind,
      ).toMatchObject({ allow: false, errorCode: "project_deactivated" });
  });
});
