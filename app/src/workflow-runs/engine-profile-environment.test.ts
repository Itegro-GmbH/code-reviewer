// SPDX-License-Identifier: LicenseRef-Proprietary

// #919: the environment of an agent step is the one of its profile version. A step that names none runs there, a step that names the
// profile's own does too, and a profile version saved before profiles had an environment still runs in the environment its step names.
import { describe, expect, it, vi } from "vitest";
import type {
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import { createConnectorRegistry } from "./connectors.ts";
import { createWorkflowEngine, type EngineDependencies } from "./engine.ts";
import { STEP_STALE_MS } from "./limits.ts";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const RUN_ID = "7f0c1b3e-aaaa-4bbb-8ccc-0123456789ab";

const ENVIRONMENTS = [
  { id: "env-python", name: "Python" },
  { id: "env-box", name: "Box" },
];

/** A document of one agent step; `environment` is left out of the step when undefined. */
const documentOf = (environment: string | undefined) => ({
  version: 1,
  name: "Issue to PR",
  trigger: { kind: "github.issueLabeled", label: "agent" },
  steps: [
    {
      id: "implement",
      kind: "agent",
      profile: "worker",
      ...(environment === undefined ? {} : { environment }),
      instruction: "Build it.",
    },
  ],
});

/** A run whose only step is claimed and has not started its turn yet: the engine starts it. */
function harness(options: {
  /** What the step writes; undefined: no `environment`. */
  step: string | undefined;
  /** The id of the environment of the profile version; null: a version saved before profiles had one. */
  profileEnvironmentId: string | null;
  environments?: typeof ENVIRONMENTS;
}) {
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
    ticketRef: null,
    createdBy: null,
    actorLogin: "octocat",
    cancelRequestedAt: null,
    failure: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    finishedAt: null,
  };
  const waiting: StoredStepRun = {
    id: "step-0",
    runId: RUN_ID,
    workspaceId: "w-1",
    position: 0,
    stepId: "implement",
    kind: "agent",
    status: "running",
    round: 1,
    profile: { name: "worker", version: 3 },
    jobId: null,
    turnId: null,
    capMicroUsd: 5_000_000,
    costMicroUsd: null,
    costBasis: null,
    output: null,
    errorCode: null,
    errorMessage: null,
    ask: null,
    waitingOnCommentId: null,
    createdAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    startedAt: new Date(NOW.getTime() - STEP_STALE_MS - 1).toISOString(),
    finishedAt: null,
  };
  const steps = [waiting];
  const settleOwnStep = vi.fn(async () => true);
  const runs: Partial<WorkflowRunsRepository> = {
    getRun: async () => run,
    listSteps: async () => steps.map((step) => ({ ...step })),
    claimStep: async () => ({ ...waiting }),
    attachTurn: async (_id, turn) => {
      waiting.jobId = turn.jobId;
      return true;
    },
    settleOwnStep,
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
    async () => ({ runId: "job-implement", sessionId: "s-1", created: true }),
  );
  const findByName = vi.fn(async () => ({
    profile: { name: "worker" },
    version: {
      version: 3,
      content: { environmentId: options.profileEnvironmentId },
    },
  }));
  const deps: EngineDependencies = {
    runs: runs as WorkflowRunsRepository,
    workflows: {
      getVersion: async () =>
        ({
          document: JSON.stringify(documentOf(options.step)),
          createdBy: "owner-1",
        }) as never,
    },
    members: { get: async () => ({}) as never },
    profiles: { findByName: findByName as never },
    environments: {
      listSummaries: async () =>
        (options.environments ?? ENVIRONMENTS).map((e) => e as never),
    },
    implementer: {
      startTask,
      continueSession: vi.fn(),
      discardRequested: vi.fn(),
    },
    jobs: { requestCancel: vi.fn() },
    turns: {
      read: async () => ({ turnId: "turn-implement", ended: undefined }),
      findByRequest: async () => undefined,
    },
    connectors: createConnectorRegistry(),
    repositoryName: async () => "acme/app",
    now: () => NOW,
    log: () => undefined,
  };
  return { engine: createWorkflowEngine(deps), startTask, settleOwnStep };
}

describe("the environment an agent step runs in", () => {
  // #919-T40
  it("is the environment of the profile when the step names none", async () => {
    const app = harness({ step: undefined, profileEnvironmentId: "env-box" });

    await app.engine.advance(RUN_ID);

    expect(app.startTask).toHaveBeenCalledTimes(1);
    expect(app.startTask.mock.calls[0]?.[1]).toMatchObject({
      environmentId: "env-box",
      profile: "worker@3",
    });
  });

  // #919-T41
  it("is the environment of the profile when the step names that one", async () => {
    const app = harness({ step: "box", profileEnvironmentId: "env-box" });

    await app.engine.advance(RUN_ID);

    expect(app.startTask.mock.calls[0]?.[1]).toMatchObject({
      environmentId: "env-box",
    });
  });

  // #919-T42
  it("is the environment the step names when the profile version has none, as before profiles had one", async () => {
    const app = harness({ step: "python", profileEnvironmentId: null });

    await app.engine.advance(RUN_ID);

    expect(app.startTask.mock.calls[0]?.[1]).toMatchObject({
      environmentId: "env-python",
    });
  });

  // #919-T43
  it("ends the step without a turn when the environment of the profile is gone", async () => {
    const app = harness({ step: undefined, profileEnvironmentId: "env-gone" });

    await app.engine.advance(RUN_ID);

    expect(app.startTask).not.toHaveBeenCalled();
    expect(app.settleOwnStep).toHaveBeenCalledWith(
      "step-0",
      expect.objectContaining({
        status: "failed",
        errorCode: "environment_not_found",
      }),
    );
  });

  // #919-T44
  it("ends the step without a turn when the step names another environment than its profile version runs in", async () => {
    const app = harness({ step: "python", profileEnvironmentId: "env-box" });

    await app.engine.advance(RUN_ID);

    expect(app.startTask).not.toHaveBeenCalled();
    expect(app.settleOwnStep).toHaveBeenCalledWith(
      "step-0",
      expect.objectContaining({
        status: "failed",
        errorCode: "environment_mismatch",
        errorMessage: expect.stringContaining("Box"),
      }),
    );
  });

  // #919-T45
  it("does not run in the environment of a lane saved against a profile version without one, once the profile it follows has one", async () => {
    // The lane was valid against version 1 (no environment, so the step named "python"); the profile it follows has since got a version
    // 2 that runs in "Box". The step is not silently moved, and not run where the profile no longer says.
    const app = harness({ step: "python", profileEnvironmentId: "env-box" });

    await app.engine.advance(RUN_ID);

    expect(app.startTask).not.toHaveBeenCalled();
    expect(app.settleOwnStep).toHaveBeenCalledWith(
      "step-0",
      expect.objectContaining({ errorCode: "environment_mismatch" }),
    );
  });

  // #919-T46
  it("ends the step with environment_not_found when the environment of the profile version belongs to another workspace", async () => {
    // The environments the engine lists are those of the workspace of the run; the id of one of another workspace is not among them.
    const app = harness({
      step: undefined,
      profileEnvironmentId: "env-of-another-workspace",
    });

    await app.engine.advance(RUN_ID);

    expect(app.startTask).not.toHaveBeenCalled();
    expect(app.settleOwnStep).toHaveBeenCalledWith(
      "step-0",
      expect.objectContaining({ errorCode: "environment_not_found" }),
    );
  });

  // #919-T47
  it("ends with environment_not_found, not a mismatch, when the profile's environment is gone and the step names one", async () => {
    const app = harness({ step: "python", profileEnvironmentId: "env-gone" });

    await app.engine.advance(RUN_ID);

    expect(app.settleOwnStep).toHaveBeenCalledWith(
      "step-0",
      expect.objectContaining({ errorCode: "environment_not_found" }),
    );
  });
});
