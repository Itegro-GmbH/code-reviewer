// SPDX-License-Identifier: LicenseRef-Proprietary

// Runs and steps as the routes give them, for the tests of the workflow pages (#873).
import type {
  RunSummaryView,
  RunView,
  StepView,
} from "../workflow-runs/service.ts";

export const JOB_ID = "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11";

export function step(overrides: Partial<StepView> = {}): StepView {
  return {
    id: "plan",
    position: 0,
    kind: "agent",
    status: "succeeded",
    profile: { name: "worker", version: 1 },
    jobId: JOB_ID,
    turnId: "turn-1",
    costUsd: 0.42,
    costBasis: "reported",
    output: {
      summary: "Cache it.",
      costUsd: 0.42,
      branch: "workflow/run-1/plan",
    },
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-11-05T10:00:00.000Z",
    startedAt: "2026-11-05T10:00:01.000Z",
    finishedAt: "2026-11-05T10:02:06.000Z",
    ...overrides,
  };
}

export function run(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowVersion: 3,
    trigger: "manual",
    actorLogin: "octocat",
    status: "running",
    errorCode: null,
    budgetUsd: 20,
    spentUsd: 0.42,
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:02:06.000Z",
    finishedAt: null,
    repositoryId: "repo-1",
    baseBranch: "main",
    input: { repo: "acme/widgets", topic: "caching" },
    steps: [step()],
    ...overrides,
  };
}

export function summary(
  overrides: Partial<RunSummaryView> = {},
): RunSummaryView {
  const full = run();
  return {
    id: full.id,
    workflowId: full.workflowId,
    workflowVersion: full.workflowVersion,
    trigger: full.trigger,
    actorLogin: full.actorLogin,
    status: full.status,
    errorCode: full.errorCode,
    budgetUsd: full.budgetUsd,
    spentUsd: full.spentUsd,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
    finishedAt: full.finishedAt,
    ...overrides,
  };
}
