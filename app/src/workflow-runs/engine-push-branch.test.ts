// SPDX-License-Identifier: LicenseRef-Proprietary

// #1177 (epic #1175): what the engine hands the Implementer for an agent step with `pushBranch`: the branch the session works on and pushes to
// is the one the step names (references filled in), made from the branch the step starts from (`branch`, else the run's base) as a one-entry
// `repos` list on the run's repository; the platform's `workflow/<run>/<step>` stays only the key of the session. A name that is no branch,
// the run's base branch and the start branch end the step before anything starts, and the refusals of the Implementer get codes of their own.
import { describe, expect, it, vi } from "vitest";
import type {
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import { ImplementerError } from "../implementer/errors.ts";
import { createConnectorRegistry } from "./connectors.ts";
import { createWorkflowEngine, type EngineDependencies } from "./engine.ts";
import { STEP_STALE_MS } from "./limits.ts";

const NOW = new Date("2026-11-26T12:00:00.000Z");
const RUN_ID = "7f0c1b3e-aaaa-4bbb-8ccc-0123456789ab";

function harness(
  stepFields: Record<string, unknown>,
  options: {
    input?: Record<string, unknown>;
    startTask?: EngineDependencies["implementer"]["startTask"];
    madeByLane?: EngineDependencies["pushBranchMadeByLane"];
  } = {},
) {
  const run: StoredWorkflowRun = {
    id: RUN_ID,
    workspaceId: "w-1",
    workflowId: "wf-1",
    workflowVersion: 1,
    repositoryId: "repo-run",
    baseBranch: "main",
    triggerInput: JSON.stringify(
      options.input ?? { repo: "acme/app", branch: "agent/handoff" },
    ),
    status: "running",
    errorCode: null,
    budgetMicroUsd: 10_000_000,
    spentMicroUsd: 0,
    clientRequestId: "request-1",
    triggerKind: "manual",
    triggerId: null,
    createdBy: "user-1",
    actorLogin: "octocat",
    cancelRequestedAt: null,
    discardedAt: null,
    pauseRequestedAt: null,
    failure: null,
    ticketRef: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    finishedAt: null,
  };
  const step: StoredStepRun = {
    id: "step-0",
    runId: RUN_ID,
    workspaceId: "w-1",
    position: 0,
    stepId: "implement",
    kind: "agent",
    status: "running",
    round: 1,
    profile: { name: "worker", version: 1 },
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
    createdAt: new Date(NOW.getTime() - STEP_STALE_MS - 1).toISOString(),
    startedAt: new Date(NOW.getTime() - STEP_STALE_MS - 1).toISOString(),
    finishedAt: null,
  };
  const settled: Array<{
    status: string;
    errorCode?: string;
    errorMessage?: string;
  }> = [];
  const runs: Partial<WorkflowRunsRepository> = {
    getRun: async () => run,
    listSteps: async () => [{ ...step }],
    claimStep: async () => ({ ...step }),
    attachTurn: async (_id, turn) => {
      step.jobId = turn.jobId;
      return true;
    },
    settleOwnStep: async (_id, outcome) => {
      settled.push(outcome as never);
      step.status = "failed";
      return true;
    },
    lockRun: async (_runId, work) =>
      work({
        run,
        steps: [step],
        attachTurn: vi.fn(),
        addStep: vi.fn(),
        addFinished: vi.fn(),
        finishStep: vi.fn(),
        finishRun: vi.fn(),
        touch: vi.fn(),
      } as never),
  };
  const startTask = vi.fn<EngineDependencies["implementer"]["startTask"]>(
    options.startTask ??
      (async () => ({ runId: "job-1", sessionId: "s-1", created: true })),
  );
  const deps: EngineDependencies = {
    runs: runs as WorkflowRunsRepository,
    workflows: {
      getVersion: async () =>
        ({
          document: JSON.stringify({
            version: 1,
            name: "Several repositories",
            trigger: {
              kind: "manual",
              input: {
                type: "object",
                required: ["repo"],
                properties: {
                  repo: { type: "string" },
                  branch: { type: "string" },
                  base: { type: "string" },
                },
              },
            },
            steps: [
              {
                id: "implement",
                kind: "agent",
                profile: "worker",
                environment: "Python",
                instruction: "Build it.",
                ...stepFields,
              },
            ],
          }),
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
      read: async () => ({ turnId: "turn-1", ended: undefined }),
      findByRequest: async () => undefined,
    },
    connectors: createConnectorRegistry(),
    repositoryName: async () => "acme/run-repo",
    ...(options.madeByLane === undefined
      ? {}
      : { pushBranchMadeByLane: options.madeByLane }),
    now: () => NOW,
    log: () => undefined,
  };
  return { engine: createWorkflowEngine(deps), startTask, settled };
}

describe("an agent step with pushBranch", () => {
  // #1177-T30
  it("starts the task on the named branch of the run's repository, made from the run's base, and keeps the platform's name as the key", async () => {
    const app = harness({ pushBranch: "{{trigger.input.branch}}" });

    await app.engine.advance(RUN_ID);

    expect(app.startTask).toHaveBeenCalledTimes(1);
    const task = app.startTask.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(task).toMatchObject({
      repositoryId: "repo-run",
      baseBranch: "main",
      repos: [
        { repositoryId: "repo-run", base: "main", branch: "agent/handoff" },
      ],
      branch: `workflow/${RUN_ID}/implement`,
    });
    expect(task).not.toHaveProperty("startBranch");
    expect(app.startTask.mock.calls[0]?.[2]).toMatchObject({
      workflowStep: true,
    });
  });

  // #1177-T31
  it("makes the branch from the start branch of the step and takes a text around an input", async () => {
    const app = harness(
      {
        branch: "{{trigger.input.base}}",
        pushBranch: "agent/{{trigger.input.branch}}",
      },
      { input: { base: "develop", branch: "x1" } },
    );
    await app.engine.advance(RUN_ID);
    const task = app.startTask.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(task.repos).toEqual([
      { repositoryId: "repo-run", base: "develop", branch: "agent/x1" },
    ]);
    expect(task).not.toHaveProperty("startBranch");
  });

  // #1177-T32
  it.each([
    ["a value that is no branch name", { branch: "bad..name" }, {}],
    ["an empty value", { branch: "" }, {}],
    ["the run's base branch", { branch: "main" }, {}],
    [
      "the branch the step starts from",
      { branch: "develop", base: "develop" },
      { branch: "{{trigger.input.base}}" },
    ],
  ])(
    "ends the step before anything starts for %s",
    async (_name, input, more) => {
      const app = harness(
        { pushBranch: "{{trigger.input.branch}}", ...more },
        { input },
      );
      await app.engine.advance(RUN_ID);
      expect(app.startTask).not.toHaveBeenCalled();
      expect(app.settled).toEqual([
        expect.objectContaining({
          status: "failed",
          errorCode: "push_branch_invalid",
        }),
      ]);
    },
  );

  // #1177-T33
  it.each([
    ["IMPLEMENTER_BRANCH_EXISTS", "push_branch_exists"],
    ["IMPLEMENTER_BRANCH_PROTECTED", "push_branch_protected"],
    ["IMPLEMENTER_BRANCH_CONFLICT", "push_branch_invalid"],
    ["IMPLEMENTER_REQUEST_INVALID", "push_branch_invalid"],
    ["IMPLEMENTER_BASE_BRANCH_NOT_FOUND", "base_branch_not_found"],
    ["IMPLEMENTER_WRITE_NOT_GRANTED", "repo_not_available"],
  ] as const)(
    "maps the refusal %s of the Implementer to %s",
    async (refusal, code) => {
      const app = harness(
        { pushBranch: "{{trigger.input.branch}}" },
        {
          startTask: async () => {
            throw new ImplementerError(refusal, "refused", { repoIndex: 0 });
          },
        },
      );
      await app.engine.advance(RUN_ID);
      expect(app.settled).toEqual([
        expect.objectContaining({ status: "failed", errorCode: code }),
      ]);
    },
  );

  // #1177-T34
  it("keeps every other refusal as agent_start_failed", async () => {
    const app = harness(
      { pushBranch: "{{trigger.input.branch}}" },
      {
        startTask: async () => {
          throw new ImplementerError("IMPLEMENTER_GITHUB_UNAVAILABLE", "down");
        },
      },
    );
    await app.engine.advance(RUN_ID);
    expect(app.settled).toEqual([
      expect.objectContaining({ errorCode: "agent_start_failed" }),
    ]);
  });

  // #1177-T35
  it("asks the lane's earlier runs whether they made a branch, for this workflow and repository", async () => {
    const madeByLane = vi.fn(async () => true);
    const app = harness(
      { pushBranch: "{{trigger.input.branch}}" },
      { madeByLane },
    );
    await app.engine.advance(RUN_ID);
    const given = app.startTask.mock.calls[0]?.[2] as {
      pushBranch: {
        madeByLane(repositoryId: string, branch: string): Promise<boolean>;
      };
    };
    await expect(
      given.pushBranch.madeByLane("repo-run", "agent/handoff"),
    ).resolves.toBe(true);
    expect(madeByLane).toHaveBeenCalledWith({
      workflowId: "wf-1",
      repositoryId: "repo-run",
      branch: "agent/handoff",
    });
  });

  // #1177-T36
  it("treats a deployment that cannot tell as: no earlier run made it", async () => {
    const app = harness({ pushBranch: "{{trigger.input.branch}}" });
    await app.engine.advance(RUN_ID);
    const given = app.startTask.mock.calls[0]?.[2] as {
      pushBranch: {
        madeByLane(repositoryId: string, branch: string): Promise<boolean>;
      };
    };
    await expect(
      given.pushBranch.madeByLane("repo-run", "agent/handoff"),
    ).resolves.toBe(false);
  });

  // #1177-T37
  it("leaves a step without pushBranch to the platform's branch, with no option", async () => {
    const app = harness({});
    await app.engine.advance(RUN_ID);
    const task = app.startTask.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(task).not.toHaveProperty("repos");
    expect(app.startTask.mock.calls[0]?.[2]).not.toHaveProperty("pushBranch");
  });
});
