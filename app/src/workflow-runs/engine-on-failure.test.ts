// SPDX-License-Identifier: LicenseRef-Proprietary

// #902: the engine around `onFailure`, with an in-memory run store and fake connectors (no database, no network). A run that would end
// `failed` or `cancelled` records how, keeps `running` while the steps of `onFailure` do their cleanup, and ends the way it was going to;
// a run that succeeded never runs them.
import { describe, expect, it, vi } from "vitest";
import type {
  NewFinishedStep,
  NewStepRun,
  RunLock,
  StepOutcome,
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import {
  ConnectorError,
  createConnectorRegistry,
  type ActionCall,
  type ActionConnector,
} from "./connectors.ts";
import { createWorkflowEngine } from "./engine.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const RUN_ID = "7f0c1b3e-aaaa-4bbb-8ccc-0123456789ab";
const ZERO_WIDTH_SPACE = "​";

const comment = (id: string, body: string) => ({
  id,
  kind: "action",
  connector: "github.issue.comment",
  issue: "{{trigger.issue}}",
  body,
});

function documentOf(
  onFailure: unknown[] | undefined,
  opensPullRequest = false,
) {
  return {
    version: 1,
    name: "Issue to PR",
    trigger: { kind: "github.issueLabeled", label: "ready" },
    steps: [
      {
        id: "implement",
        kind: "agent",
        profile: "worker",
        environment: "node",
        instruction: "Do it.",
      },
      opensPullRequest
        ? {
            id: "pr",
            kind: "action",
            connector: "github.pullRequest.open",
            head: "workflow/r1/work",
            title: "Add caching",
          }
        : {
            id: "open",
            kind: "action",
            connector: "github.issue.comment",
            issue: "{{trigger.issue}}",
            body: "Done.",
          },
    ],
    ...(onFailure === undefined ? {} : { onFailure }),
  };
}

const CLEANUP = [
  comment(
    "report",
    "Stopped at {{failure.stepId}} ({{failure.status}}, {{failure.code}}): {{failure.message}}",
  ),
  {
    id: "unlabel",
    kind: "action",
    connector: "github.issue.labels",
    issue: "{{trigger.issue}}",
    remove: ["agent working"],
    add: ["agent failed"],
  },
];

function stepRow(
  position: number,
  overrides: Partial<StoredStepRun>,
): StoredStepRun {
  return {
    id: `step-${String(position)}`,
    runId: RUN_ID,
    workspaceId: "w-1",
    position,
    stepId: "implement",
    kind: "agent",
    status: "succeeded",
    round: 1,
    profile: { name: "worker", version: 1 },
    jobId: "job-1",
    turnId: "turn-1",
    capMicroUsd: 5_000_000,
    costMicroUsd: 1_000_000,
    costBasis: "reported",
    output: "{}",
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(NOW.getTime() - 600_000).toISOString(),
    startedAt: new Date(NOW.getTime() - 600_000).toISOString(),
    finishedAt: new Date(NOW.getTime() - 500_000).toISOString(),
    ...overrides,
  };
}

const failedImplement = (message = "The agent did not report a result.") =>
  stepRow(0, {
    status: "failed",
    errorCode: "no_result",
    errorMessage: message,
    output: null,
  });

type Calls = Array<{ connector: string; stepId: string; inputs: unknown }>;

function harness(options: {
  onFailure?: unknown[] | undefined;
  /** The second step of the workflow opens a pull request instead of commenting. */
  opensPullRequest?: boolean;
  steps?: StoredStepRun[];
  run?: Partial<StoredWorkflowRun>;
  /** Connectors that fail, by name. */
  failing?: Record<string, ConnectorError>;
  /** Runs when a connector is called, before it answers: for a cancel that comes while the cleanup runs. */
  during?: () => void;
}) {
  const run: StoredWorkflowRun = {
    id: RUN_ID,
    workspaceId: "w-1",
    workflowId: "wf-1",
    workflowVersion: 1,
    repositoryId: "repo-1",
    baseBranch: "main",
    triggerInput: JSON.stringify({
      issue: { number: 7, title: "Fix it", body: "", url: "u", labels: [] },
      repo: {
        fullName: "acme/app",
        owner: "acme",
        name: "app",
        defaultBranch: "main",
      },
    }),
    status: "running",
    errorCode: null,
    budgetMicroUsd: 20_000_000,
    spentMicroUsd: 1_000_000,
    clientRequestId: "request-1",
    triggerKind: "github.issueLabeled",
    createdBy: "u-1",
    actorLogin: "octocat",
    cancelRequestedAt: null,
    failure: null,
    ticketRef: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    finishedAt: null,
    ...options.run,
  };
  const steps: StoredStepRun[] = options.steps ?? [failedImplement()];
  const calls: Calls = [];
  const connector = (name: string): ActionConnector => ({
    name,
    async run(call: ActionCall) {
      options.during?.();
      calls.push({ connector: name, stepId: call.stepId, inputs: call.inputs });
      const failure = options.failing?.[name];
      if (failure !== undefined) throw failure;
      if (name === "github.pullRequest.open")
        return { number: 12, url: "https://github.test/p/12", existing: false };
      return name === "github.issue.comment"
        ? { url: "https://github.test/c/1" }
        : { labels: [] };
    },
  });
  const write = (
    input: NewStepRun | NewFinishedStep,
    patch: Partial<StoredStepRun>,
  ) => {
    const row = stepRow(input.position, {
      stepId: input.stepId,
      kind: input.kind,
      round: input.round,
      jobId: null,
      turnId: null,
      profile: null,
      costMicroUsd: null,
      costBasis: null,
      output: null,
      startedAt: null,
      finishedAt: null,
      createdAt: NOW.toISOString(),
      ...patch,
    });
    steps.push(row);
    return row;
  };
  const finishStep = (id: string, outcome: StepOutcome): void => {
    const row = steps.find((candidate) => candidate.id === id);
    if (
      row === undefined ||
      ["succeeded", "failed", "skipped"].includes(row.status)
    )
      return;
    row.finishedAt = NOW.toISOString();
    if (outcome.status === "skipped") row.status = "skipped";
    else if (outcome.status === "succeeded") {
      row.status = "succeeded";
      row.output = outcome.output;
    } else {
      row.status = "failed";
      row.errorCode = outcome.errorCode;
      row.errorMessage = outcome.errorMessage;
    }
  };
  const lock = (): RunLock => {
    const current: RunLock = {
      run,
      steps,
      async addStep(input) {
        return write(input, {
          status: "pending",
          kind: input.kind,
          capMicroUsd: input.capMicroUsd,
        });
      },
      async addFinished(inputs) {
        return inputs.map((input) =>
          write(input, {
            status: input.status,
            output: input.output,
            finishedAt: NOW.toISOString(),
          }),
        );
      },
      attachTurn: vi.fn(),
      async finishStep(id, outcome) {
        finishStep(id, outcome);
      },
      async finishRun(outcome) {
        run.status = outcome.status;
        run.errorCode = outcome.errorCode;
        run.finishedAt = NOW.toISOString();
      },
      async requestCancel() {
        run.cancelRequestedAt = NOW.toISOString();
        return true;
      },
      async beginFailure(failure) {
        if (run.failure !== null || run.status !== "running") return false;
        run.failure = failure;
        return true;
      },
      async touch() {},
    };
    return current;
  };
  const runs: Partial<WorkflowRunsRepository> = {
    getRun: async () => ({ ...run }),
    listSteps: async () => steps.map((row) => ({ ...row })),
    claimStep: async (id) => {
      const row = steps.find((candidate) => candidate.id === id);
      if (row === undefined || row.status !== "pending") return undefined;
      row.status = "running";
      row.startedAt = NOW.toISOString();
      return { ...row };
    },
    settleOwnStep: async (id, outcome) => {
      finishStep(id, outcome);
      return true;
    },
    lockRun: async (_runId, work) => {
      const held = lock();
      return work(held);
    },
  };
  const startTask = vi.fn();
  const requestCancel = vi.fn(async () => ({ status: "requested" }) as never);
  const engine = createWorkflowEngine({
    runs: runs as WorkflowRunsRepository,
    workflows: {
      getVersion: async () =>
        ({
          document: JSON.stringify(
            documentOf(options.onFailure, options.opensPullRequest),
          ),
          createdBy: "u-1",
        }) as never,
    },
    members: { get: async () => ({}) as never },
    profiles: { findByName: async () => undefined },
    environments: { listSummaries: async () => [] },
    implementer: {
      startTask,
      continueSession: vi.fn(),
      discardRequested: vi.fn(),
    },
    jobs: { requestCancel },
    turns: {
      // A turn that runs.
      read: async () => ({ turnId: "turn-1", ended: undefined }),
      findByRequest: async () => undefined,
    },
    connectors: createConnectorRegistry([
      connector("github.issue.comment"),
      connector("github.issue.labels"),
      connector("github.pullRequest.open"),
    ]),
    repositoryName: async () => "acme/app",
    now: () => NOW,
    log: () => undefined,
  });
  return { engine, run, steps, calls, startTask, requestCancel };
}

const rowsOf = (steps: StoredStepRun[]) =>
  steps.map((row) => [row.stepId, row.status]);

describe("a run that fails, in a workflow with onFailure steps", () => {
  // #902-T50
  it("comments and swaps the label, then ends failed with the error code it had", async () => {
    const app = harness({ onFailure: CLEANUP });

    await app.engine.advance(RUN_ID);

    expect(app.calls.map((call) => [call.connector, call.stepId])).toEqual([
      ["github.issue.comment", "report"],
      ["github.issue.labels", "unlabel"],
    ]);
    expect(app.calls[0]?.inputs).toMatchObject({
      issue: 7,
      body: "Stopped at implement (failed, no_result): The agent did not report a result.",
    });
    expect(app.calls[1]?.inputs).toMatchObject({
      issue: 7,
      remove: ["agent working"],
      add: ["agent failed"],
    });
    expect(rowsOf(app.steps)).toEqual([
      ["implement", "failed"],
      ["report", "succeeded"],
      ["unlabel", "succeeded"],
    ]);
    expect(app.run).toMatchObject({
      status: "failed",
      errorCode: "step_failed",
      spentMicroUsd: 1_000_000,
    });
    expect(app.startTask).not.toHaveBeenCalled();
  });

  // #902-T51
  it("defuses the message and the code of the failure like any text it cannot trust", async () => {
    const app = harness({
      onFailure: CLEANUP,
      steps: [failedImplement("Ask @org/team to close #12. <!-- marker -->")],
    });

    await app.engine.advance(RUN_ID);

    const body = (app.calls[0]?.inputs as { body: string }).body;
    expect(body).toContain(`@${ZERO_WIDTH_SPACE}org`);
    expect(body).toContain(`#${ZERO_WIDTH_SPACE}12`);
    expect(body).toContain(`<!-${ZERO_WIDTH_SPACE}-`);
    expect(body).not.toContain("@org");
  });

  // #913-T04
  it("ends a run whose pull request is refused failed, and the steps of onFailure read GitHub's reason in failure.message", async () => {
    const reason =
      "GitHub refused the request: one of the values is not accepted (for example a branch that does not exist). GitHub said: PullRequest head invalid.";
    const app = harness({
      onFailure: CLEANUP,
      opensPullRequest: true,
      steps: [stepRow(0, {})],
      failing: {
        "github.pullRequest.open": new ConnectorError(
          "github_validation",
          reason,
        ),
      },
    });

    await app.engine.advance(RUN_ID);

    expect(app.steps[1]).toMatchObject({
      stepId: "pr",
      status: "failed",
      errorCode: "github_validation",
      errorMessage: reason,
    });
    expect(app.calls.map((call) => [call.connector, call.stepId])).toEqual([
      ["github.pullRequest.open", "pr"],
      ["github.issue.comment", "report"],
      ["github.issue.labels", "unlabel"],
    ]);
    expect(app.calls[1]?.inputs).toMatchObject({
      body: `Stopped at pr (failed, github_validation): ${reason}`,
    });
    expect(app.run).toMatchObject({
      status: "failed",
      errorCode: "step_failed",
    });
  });

  // #902-T52
  it("is repeated without effect: a second look finds the run over and calls nothing", async () => {
    const app = harness({ onFailure: CLEANUP });

    await app.engine.advance(RUN_ID);
    await app.engine.advance(RUN_ID);

    expect(app.calls).toHaveLength(2);
    expect(app.run.status).toBe("failed");
  });

  // #902-T53
  it("records a step of onFailure that fails, runs the next one, and still ends failed", async () => {
    const app = harness({
      onFailure: CLEANUP,
      failing: {
        "github.issue.comment": new ConnectorError(
          "github_not_found",
          "GitHub has no such issue.",
        ),
      },
    });

    await app.engine.advance(RUN_ID);

    expect(rowsOf(app.steps)).toEqual([
      ["implement", "failed"],
      ["report", "failed"],
      ["unlabel", "succeeded"],
    ]);
    expect(app.steps[1]).toMatchObject({ errorCode: "github_not_found" });
    expect(app.run).toMatchObject({
      status: "failed",
      errorCode: "step_failed",
    });
  });

  // #902-T54
  it("runs when the budget is the reason, and spends nothing", async () => {
    const app = harness({
      onFailure: CLEANUP,
      steps: [],
      run: { spentMicroUsd: 20_000_000 },
    });

    await app.engine.advance(RUN_ID);

    expect(app.calls).toHaveLength(2);
    expect(app.calls[0]?.inputs).toMatchObject({
      body: expect.stringContaining(
        "implement (failed, budget_exhausted)",
      ) as unknown as string,
    });
    expect(app.run).toMatchObject({
      status: "failed",
      errorCode: "budget_exhausted",
      spentMicroUsd: 20_000_000,
    });
  });

  // #902-T55
  it("ends at once, as before, when the workflow has no onFailure steps", async () => {
    const app = harness({ onFailure: undefined });

    await app.engine.advance(RUN_ID);

    expect(app.calls).toEqual([]);
    expect(app.run).toMatchObject({
      status: "failed",
      errorCode: "step_failed",
    });
    expect(app.run.failure).toBeNull();
  });
});

describe("a run that is cancelled, in a workflow with onFailure steps", () => {
  const stopped = () =>
    stepRow(0, {
      status: "failed",
      errorCode: "cancelled",
      errorMessage: "A member stopped the run.",
      output: null,
    });

  // #902-T56
  it("runs them after the agent has stopped, and ends cancelled without an error code", async () => {
    const app = harness({
      onFailure: CLEANUP,
      steps: [stopped()],
      run: { cancelRequestedAt: NOW.toISOString() },
    });

    await app.engine.advance(RUN_ID);

    expect(app.calls[0]?.inputs).toMatchObject({
      body: "Stopped at implement (cancelled, cancelled): A member stopped the run.",
    });
    expect(rowsOf(app.steps)).toEqual([
      ["implement", "failed"],
      ["report", "succeeded"],
      ["unlabel", "succeeded"],
    ]);
    expect(app.run).toMatchObject({ status: "cancelled", errorCode: null });
  });

  // #902-T57
  it("does not start them while the agent still runs", async () => {
    const app = harness({
      onFailure: CLEANUP,
      steps: [
        stepRow(0, {
          status: "running",
          jobId: "job-1",
          finishedAt: null,
          output: null,
        }),
      ],
      run: { cancelRequestedAt: NOW.toISOString() },
    });

    await app.engine.advance(RUN_ID);

    expect(app.requestCancel).toHaveBeenCalledWith("job-1");
    expect(app.calls).toEqual([]);
    expect(app.run.status).toBe("running");
    expect(app.run.failure).toBeNull();
  });

  // #902-T58
  it("takes a cancel that comes while they run for what it is: the run still ends failed", async () => {
    const holder: { app?: ReturnType<typeof harness> } = {};
    const app = harness({
      onFailure: CLEANUP,
      during: () => {
        if (holder.app !== undefined)
          holder.app.run.cancelRequestedAt = NOW.toISOString();
      },
    });
    holder.app = app;

    await app.engine.advance(RUN_ID);

    expect(app.calls).toHaveLength(2);
    expect(rowsOf(app.steps)).toEqual([
      ["implement", "failed"],
      ["report", "succeeded"],
      ["unlabel", "succeeded"],
    ]);
    expect(app.run).toMatchObject({
      status: "failed",
      errorCode: "step_failed",
    });
  });
});

describe("a run that succeeds, in a workflow with onFailure steps", () => {
  // #902-T59
  it("does not run them", async () => {
    const app = harness({
      onFailure: CLEANUP,
      steps: [
        stepRow(0, { output: "{}" }),
        stepRow(1, {
          stepId: "open",
          kind: "action",
          jobId: null,
          turnId: null,
          profile: null,
          output: JSON.stringify({ url: "u" }),
        }),
      ],
    });

    await app.engine.advance(RUN_ID);

    expect(app.calls).toEqual([]);
    expect(app.run).toMatchObject({ status: "succeeded", errorCode: null });
  });
});
