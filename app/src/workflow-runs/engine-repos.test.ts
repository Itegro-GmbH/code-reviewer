// SPDX-License-Identifier: LicenseRef-Proprietary

// #1092 (epic #1090, ADR 0006): what the engine hands the Implementer for an agent step with `repos`: each repository found in the workspace by
// its full name (without regard to case), the base and the branch with their references filled in, and no use of the run's repository. A
// reference that gives no repository or no branch, two entries that are one repository, mount names that clash, a repository the workspace
// does not have and the refusals of the Implementer end the step before the agent starts, with a code of their own.
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

const NOW = new Date("2026-11-18T12:00:00.000Z");
const RUN_ID = "7f0c1b3e-aaaa-4bbb-8ccc-0123456789ab";

type Entry = { repo: string; base?: string; branch?: string };

function harness(
  repos: Entry[],
  options: {
    input?: Record<string, unknown>;
    known?: Record<string, string>;
    startTask?: EngineDependencies["implementer"]["startTask"];
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
      options.input ?? { ticket: { key: "PROJ-7", number: 0 } },
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
  const known = options.known ?? {
    "acme/app": "repo-app",
    "acme/lib": "repo-lib",
    "other/app": "repo-other",
  };
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
                properties: { repo: { type: "string" } },
              },
            },
            steps: [
              {
                id: "implement",
                kind: "agent",
                profile: "worker",
                environment: "Python",
                instruction: "Build it.",
                repos,
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
    repositoryByName: async (fullName) => {
      const id = known[fullName.toLowerCase()];
      return id === undefined ? undefined : { id, fullName };
    },
    now: () => NOW,
    log: () => undefined,
  };
  return { engine: createWorkflowEngine(deps), startTask, settled };
}

describe("an agent step with repos", () => {
  // #1092-T70
  it("starts the task on the repositories of the step, not on the run's, with the references filled in", async () => {
    const app = harness(
      [
        {
          repo: "Acme/App",
          branch: "feature/{{trigger.input.key}}",
          base: "develop",
        },
        { repo: "{{trigger.input.repo}}" },
      ],
      { input: { key: "PROJ-7", repo: "acme/lib" } },
    );

    await app.engine.advance(RUN_ID);

    expect(app.startTask).toHaveBeenCalledTimes(1);
    const task = app.startTask.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(task).toMatchObject({
      repositoryId: "repo-app",
      repos: [
        { repositoryId: "repo-app", base: "develop", branch: "feature/PROJ-7" },
        { repositoryId: "repo-lib" },
      ],
      branch: `workflow/${RUN_ID}/implement`,
    });
    expect(task).not.toHaveProperty("startBranch");
    expect((task.repos as object[])[1]).not.toHaveProperty("base");
  });

  // #1092-T71
  it.each([
    [
      "a reference that gives no repository",
      [{ repo: "{{trigger.input.repo}}" }],
      { repo: "not a repo" },
      "repo_invalid",
    ],
    [
      "a reference that gives no branch name",
      [{ repo: "acme/app", branch: "{{trigger.input.repo}}" }],
      { repo: "bad..branch" },
      "branch_invalid",
    ],
    [
      "two entries that are one repository without regard to case",
      [{ repo: "acme/app" }, { repo: "{{trigger.input.repo}}" }],
      { repo: "ACME/APP" },
      "repo_duplicate",
    ],
    [
      "a repository whose mount name starts with a dash (the runner would end the job invalid_job)",
      [{ repo: "acme/app" }, { repo: "{{trigger.input.repo}}" }],
      { repo: "acme/-app" },
      "repo_invalid",
    ],
    [
      "a repository named .git",
      [{ repo: "acme/app" }, { repo: "{{trigger.input.repo}}" }],
      { repo: "acme/.git" },
      "repo_invalid",
    ],
    [
      "mount names that clash",
      [
        { repo: "acme/app" },
        { repo: "other/app" },
        { repo: "{{trigger.input.repo}}" },
      ],
      { repo: "acme/acme__app" },
      "repo_name_clash",
    ],
  ])(
    "ends the step before anything starts for %s",
    async (_name, repos, input, code) => {
      const app = harness(repos, {
        input,
        known: {
          "acme/app": "a",
          "other/app": "b",
          "acme/acme__app": "c",
        },
      });

      await app.engine.advance(RUN_ID);

      expect(app.startTask).not.toHaveBeenCalled();
      expect(app.settled).toEqual([
        expect.objectContaining({ status: "failed", errorCode: code }),
      ]);
    },
  );

  // #1092-T72
  it("ends the step with repo_not_available for a repository the workspace does not have", async () => {
    const app = harness([{ repo: "acme/app" }, { repo: "nobody/gone" }]);
    await app.engine.advance(RUN_ID);
    expect(app.startTask).not.toHaveBeenCalled();
    expect(app.settled).toEqual([
      expect.objectContaining({ errorCode: "repo_not_available" }),
    ]);
  });

  // #1092-T73
  it.each([
    ["IMPLEMENTER_BASE_BRANCH_NOT_FOUND", "base_branch_not_found"],
    ["IMPLEMENTER_WRITE_NOT_GRANTED", "repo_not_available"],
    ["IMPLEMENTER_APP_NOT_INSTALLED", "repo_not_available"],
    ["IMPLEMENTER_REPOSITORY_NOT_FOUND", "repo_not_available"],
  ] as const)(
    "maps the refusal %s of the Implementer for a repository to %s",
    async (refusal, code) => {
      const app = harness([{ repo: "acme/app" }, { repo: "acme/lib" }], {
        startTask: async () => {
          throw new ImplementerError(refusal, "refused", { repoIndex: 1 });
        },
      });
      await app.engine.advance(RUN_ID);
      expect(app.settled).toEqual([
        expect.objectContaining({
          status: "failed",
          errorCode: code,
          errorMessage: expect.stringContaining("acme/lib"),
        }),
      ]);
    },
  );

  // #1092-T74
  it("keeps every other refusal of the Implementer as agent_start_failed", async () => {
    const app = harness([{ repo: "acme/app" }], {
      startTask: async () => {
        throw new ImplementerError("IMPLEMENTER_GITHUB_UNAVAILABLE", "down");
      },
    });
    await app.engine.advance(RUN_ID);
    expect(app.settled).toEqual([
      expect.objectContaining({ errorCode: "agent_start_failed" }),
    ]);
  });
});
