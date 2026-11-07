// SPDX-License-Identifier: LicenseRef-Proprietary

// #909: what the engine hands the Implementer as the branches of an agent step. The base branch is the run's, whatever the step starts
// from; a step with `branch` starts from that branch (`startBranch`), a step without one starts at the tip of the base.
// #918: the engine also hands the Implementer the time limit of the document (`turnTimeLimitMinutes`) with the cap of the budget.
import { describe, expect, it, vi } from "vitest";
import type {
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import { createConnectorRegistry } from "./connectors.ts";
import { createWorkflowEngine, type EngineDependencies } from "./engine.ts";
import { STEP_STALE_MS } from "./limits.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const RUN_ID = "7f0c1b3e-aaaa-4bbb-8ccc-0123456789ab";
const IMPLEMENT_BRANCH = `workflow/${RUN_ID}/implement`;

const documentOf = (
  branch: string | undefined,
  turnTimeLimitMinutes?: number,
) => ({
  version: 1,
  name: "Issue to PR",
  trigger: { kind: "github.issueLabeled", label: "agent" },
  ...(turnTimeLimitMinutes === undefined ? {} : { turnTimeLimitMinutes }),
  steps: [
    {
      id: "implement",
      kind: "agent",
      profile: "worker",
      environment: "Python",
      instruction: "Build it.",
    },
    {
      id: "review",
      kind: "agent",
      profile: "worker",
      environment: "Python",
      instruction: "Review it.",
      ...(branch === undefined ? {} : { branch }),
    },
  ],
});

function stepRow(overrides: Partial<StoredStepRun>): StoredStepRun {
  return {
    id: "step-0",
    runId: RUN_ID,
    workspaceId: "w-1",
    position: 0,
    stepId: "implement",
    kind: "agent",
    status: "succeeded",
    round: 1,
    profile: { name: "worker", version: 1 },
    jobId: "job-implement",
    turnId: "turn-implement",
    capMicroUsd: 5_000_000,
    costMicroUsd: 0,
    costBasis: null,
    output: JSON.stringify({ branch: IMPLEMENT_BRANCH }),
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    startedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

/** A run whose second step is claimed and has not started its turn yet: the engine starts it. */
function harness(branch: string | undefined, turnTimeLimitMinutes?: number) {
  const run: StoredWorkflowRun = {
    id: RUN_ID,
    workspaceId: "w-1",
    workflowId: "wf-1",
    workflowVersion: 1,
    repositoryId: "repo-1",
    baseBranch: "main",
    triggerInput: "{}",
    status: "running",
    errorCode: null,
    budgetMicroUsd: 10_000_000,
    spentMicroUsd: 0,
    clientRequestId: "request-1",
    triggerKind: "github.issueLabeled",
    triggerId: null,
    createdBy: null,
    actorLogin: "octocat",
    cancelRequestedAt: null,
    failure: null,
    ticketRef: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    finishedAt: null,
  };
  const waiting = stepRow({
    id: "step-1",
    position: 1,
    stepId: "review",
    status: "running",
    jobId: null,
    turnId: null,
    output: null,
    costMicroUsd: null,
    startedAt: new Date(NOW.getTime() - STEP_STALE_MS - 1).toISOString(),
  });
  const steps = [stepRow({}), waiting];
  const runs: Partial<WorkflowRunsRepository> = {
    getRun: async () => run,
    listSteps: async () => steps.map((step) => ({ ...step })),
    claimStep: async () => ({ ...waiting }),
    attachTurn: async (_id, turn) => {
      waiting.jobId = turn.jobId;
      return true;
    },
    settleOwnStep: async () => true,
    lockRun: async (_runId, work) =>
      work({
        run,
        steps,
        attachTurn: vi.fn(),
        addStep: vi.fn(),
        addFinished: vi.fn(),
        finishStep: vi.fn(),
        finishRun: vi.fn(),
        touch: vi.fn(),
      } as never),
  };
  const startTask = vi.fn<EngineDependencies["implementer"]["startTask"]>(
    async () => ({ runId: "job-review", sessionId: "s-2", created: true }),
  );
  const deps: EngineDependencies = {
    runs: runs as WorkflowRunsRepository,
    workflows: {
      getVersion: async () =>
        ({
          document: JSON.stringify(documentOf(branch, turnTimeLimitMinutes)),
          createdBy: "owner-1",
        }) as never,
    },
    members: { get: async () => ({}) as never },
    profiles: { findByName: async () => undefined },
    environments: {
      listSummaries: async () => [{ id: "env-1", name: "Python" } as never],
    },
    implementer: {
      startTask,
      continueSession: vi.fn(),
      discardRequested: vi.fn(),
    },
    jobs: { requestCancel: vi.fn() },
    turns: {
      read: async () => ({ turnId: "turn-review", ended: undefined }),
      findByRequest: async () => undefined,
    },
    connectors: createConnectorRegistry(),
    repositoryName: async () => "acme/app",
    now: () => NOW,
    log: () => undefined,
  };
  return { engine: createWorkflowEngine(deps), startTask };
}

describe("the branches an agent step starts its session with", () => {
  // #909-T06
  it("sends the run's base as baseBranch and the step's branch as startBranch", async () => {
    const app = harness("{{implement.branch}}");

    await app.engine.advance(RUN_ID);

    expect(app.startTask).toHaveBeenCalledTimes(1);
    expect(app.startTask.mock.calls[0]?.[1]).toMatchObject({
      baseBranch: "main",
      startBranch: IMPLEMENT_BRANCH,
      branch: `workflow/${RUN_ID}/review`,
    });
  });

  // #909-T06
  it("sends no startBranch for a step without a branch", async () => {
    const app = harness(undefined);

    await app.engine.advance(RUN_ID);

    expect(app.startTask).toHaveBeenCalledTimes(1);
    const task = app.startTask.mock.calls[0]?.[1];
    expect(task).toMatchObject({ baseBranch: "main" });
    expect(task).not.toHaveProperty("startBranch");
  });
});

describe("the time limit of a turn", () => {
  // #918-T04
  it("hands the Implementer the turnTimeLimitMinutes of the document with the cap of the budget", async () => {
    const app = harness(undefined, 15);

    await app.engine.advance(RUN_ID);

    expect(app.startTask).toHaveBeenCalledTimes(1);
    expect(app.startTask.mock.calls[0]?.[2]).toEqual({
      costCapCents: 500,
      timeLimitMinutes: 15,
    });
  });

  // #918-T05
  it("gives a document without the field the default of 60 minutes", async () => {
    const app = harness(undefined);

    await app.engine.advance(RUN_ID);

    expect(app.startTask.mock.calls[0]?.[2]).toMatchObject({
      timeLimitMinutes: 60,
    });
  });
});
