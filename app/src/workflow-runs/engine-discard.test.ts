// SPDX-License-Identifier: LicenseRef-Proprietary

// #921: a member discards a run while an agent step is being started. The discard ends the steps that run, but the start of a step is
// not under the lock of the run: a step that was claimed before the discard must not start anything after it, and an instruction it
// queued behind a busy session must be taken out again.
import { describe, expect, it, vi } from "vitest";
import type {
  StepOutcome,
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import { createConnectorRegistry } from "./connectors.ts";
import { serializeAsk, type StepAsk } from "./ask.ts";
import {
  createWorkflowEngine,
  type AskChannel,
  type EngineDependencies,
} from "./engine.ts";
import { STEP_STALE_MS } from "./limits.ts";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const RUN_ID = "7f0c1b3e-aaaa-4bbb-8ccc-0123456789ab";
const SESSION_ID = "session-1";
const REQUEST_ID = `wf-${RUN_ID}-1`;

const documentOf = (continues: boolean) => ({
  version: 1,
  name: "Review and fix",
  trigger: { kind: "github.issueLabeled", label: "agent" },
  steps: [
    {
      id: "plan",
      kind: "agent",
      profile: "worker",
      environment: "Python",
      instruction: "Plan it.",
    },
    {
      id: "fix",
      kind: "agent",
      profile: "worker",
      environment: "Python",
      instruction: "Fix it.",
      ...(continues ? { session: { continue: "plan" } } : {}),
    },
  ],
});

function stepRow(overrides: Partial<StoredStepRun>): StoredStepRun {
  return {
    id: "step-0",
    runId: RUN_ID,
    workspaceId: "w-1",
    position: 0,
    stepId: "plan",
    kind: "agent",
    status: "succeeded",
    round: 1,
    profile: { name: "worker", version: 1 },
    jobId: null,
    turnId: null,
    capMicroUsd: 5_000_000,
    costMicroUsd: 0,
    costBasis: null,
    output: "{}",
    errorCode: null,
    errorMessage: null,
    ask: null,
    waitingOnCommentId: null,
    createdAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

/**
 * A run a label started whose second step is the one to start. `discardWhen` says at which moment a member discards the run: while the
 * step is claimed (`claim`), or while the Implementer is asked to queue the instruction (`continue`).
 */
function harness(options: {
  continues: boolean;
  discardWhen: "claim" | "continue";
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
    createdBy: null,
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
  const steps: StoredStepRun[] = [
    stepRow({ jobId: "job-plan", turnId: "turn-plan" }),
    stepRow({
      id: "step-1",
      position: 1,
      stepId: "fix",
      status: "running",
      output: null,
      costMicroUsd: null,
      // Claimed long ago and without a turn: the next look takes it over.
      startedAt: new Date(NOW.getTime() - STEP_STALE_MS - 1).toISOString(),
    }),
  ];
  const waiting = steps[1];
  if (waiting === undefined) throw new Error("unreachable");
  const discard = () => {
    run.status = "discarded";
    waiting.status = "failed";
  };
  const settled: Array<{ id: string; outcome: StepOutcome }> = [];
  const runs: Partial<WorkflowRunsRepository> = {
    getRun: async () => ({ ...run }),
    listSteps: async () => steps.map((step) => ({ ...step })),
    claimStep: async () => {
      if (options.discardWhen === "claim") discard();
      return { ...waiting, status: "running" };
    },
    settleOwnStep: async (id, outcome) => {
      settled.push({ id, outcome });
      return true;
    },
    attachTurn: async () => true,
    lockRun: async (_runId, work) =>
      work({
        run,
        steps,
        attachTurn: async () => true,
        addStep: vi.fn(),
        addFinished: vi.fn(),
        finishStep: vi.fn(),
        finishRun: vi.fn(),
        touch: vi.fn(),
      } as never),
  };
  const startTask = vi.fn<EngineDependencies["implementer"]["startTask"]>(
    async () => {
      throw new Error("a discarded run starts no session");
    },
  );
  const continueSession = vi.fn<
    EngineDependencies["implementer"]["continueSession"]
  >(async () => {
    if (options.discardWhen === "continue") discard();
    // The session runs a turn already: the instruction is queued, and no turn is started for it.
    return { runId: null } as never;
  });
  const discardRequested = vi.fn<
    EngineDependencies["implementer"]["discardRequested"]
  >(async () => true);
  const requestCancel = vi.fn<EngineDependencies["jobs"]["requestCancel"]>();
  const deps: EngineDependencies = {
    runs: runs as WorkflowRunsRepository,
    workflows: {
      getVersion: async () =>
        ({
          document: JSON.stringify(documentOf(options.continues)),
          createdBy: "owner-1",
        }) as never,
    },
    members: { get: async () => ({}) as never },
    profiles: { findByName: async () => undefined },
    environments: {
      listSummaries: async () => [{ id: "env-1", name: "Python" } as never],
    },
    implementer: { startTask, continueSession, discardRequested },
    jobs: { requestCancel },
    turns: {
      read: async (jobId) =>
        jobId === "job-plan"
          ? {
              turnId: "turn-plan",
              ended: {
                session: { id: SESSION_ID },
                turn: { costLimitCents: null },
              } as never,
            }
          : { turnId: "turn-fix", ended: undefined },
      findByRequest: async () => undefined,
    },
    connectors: createConnectorRegistry(),
    repositoryName: async () => "acme/app",
    now: () => NOW,
    log: () => undefined,
  };
  return {
    engine: createWorkflowEngine(deps),
    settled,
    startTask,
    continueSession,
    discardRequested,
  };
}

describe("a step that is claimed while a member discards the run", () => {
  // #921-T90
  it("starts no session and no turn after the claim", async () => {
    const app = harness({ continues: false, discardWhen: "claim" });

    await app.engine.advance(RUN_ID);

    expect(app.startTask).not.toHaveBeenCalled();
    expect(app.continueSession).not.toHaveBeenCalled();
    expect(app.settled).toEqual([
      { id: "step-1", outcome: expect.objectContaining({ status: "skipped" }) },
    ]);
  });

  // #921-T91
  it("takes the instruction it queued behind a busy session out again", async () => {
    const app = harness({ continues: true, discardWhen: "continue" });

    await app.engine.advance(RUN_ID);

    expect(app.continueSession).toHaveBeenCalledOnce();
    expect(app.discardRequested).toHaveBeenCalledWith(SESSION_ID, REQUEST_ID);
  });
});

const ASKED: StepAsk = {
  n: 1,
  state: "open",
  question: "Retry which failures?",
  options: ["Network errors", "Network errors and 5xx answers"],
};

function runOf(
  id: string,
  patch: Partial<StoredWorkflowRun>,
): StoredWorkflowRun {
  return {
    id,
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
    clientRequestId: id,
    triggerKind: "ticket.labeled",
    triggerId: null,
    createdBy: null,
    actorLogin: "octocat",
    cancelRequestedAt: null,
    discardedAt: null,
    pauseRequestedAt: null,
    failure: null,
    ticketRef: "github:acme/app#12",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    finishedAt: null,
    ...patch,
  };
}

/**
 * The run `A` (a member discards it) and, optionally, the run `B` that goes on in the same repository. What the engine tells the ask channel
 * is recorded: `discarded` holds one entry per call, `freeTicket` and whether a question was open.
 */
function discardHarness(options: {
  a: Partial<StoredWorkflowRun>;
  aSteps?: StoredStepRun[];
  b?: Partial<StoredWorkflowRun>;
  /** The look for other runs of the repository fails. */
  lookupFails?: boolean;
}) {
  const a = runOf("run-a", options.a);
  const steps = options.aSteps ?? [];
  const b = options.b === undefined ? undefined : runOf("run-b", options.b);
  const discarded: Array<{ freeTicket: boolean; open: string | undefined }> =
    [];
  const runs: Partial<WorkflowRunsRepository> = {
    getRun: async () => ({ ...a }),
    listSteps: async (runId) => (runId === "run-a" ? steps : []),
    listActiveOnRepository: async () => {
      if (options.lookupFails === true) throw new Error("database down");
      return [a, ...(b === undefined ? [] : [b])].filter(
        (run) => run.status === "running" || run.status === "waiting",
      );
    },
    lockRun: async (_runId, work) => {
      const lock = {
        run: a,
        steps,
        finishStep: async (id: string, outcome: StepOutcome) => {
          // As the real lock does: the row is replaced, and the rows the caller copied before keep what they were.
          const at = steps.findIndex((candidate) => candidate.id === id);
          const step = steps[at];
          if (step !== undefined)
            steps[at] = {
              ...step,
              status: outcome.status,
              errorCode: outcome.status === "failed" ? outcome.errorCode : null,
            };
        },
        discardRun: async () => {
          const at = NOW.toISOString();
          lock.run = {
            ...lock.run,
            status: "discarded",
            discardedAt: at,
            finishedAt: lock.run.finishedAt ?? at,
          };
          Object.assign(a, lock.run);
          return true;
        },
      };
      return work(lock as never);
    },
  };
  const asks: AskChannel = {
    asked: async () => undefined,
    answered: async () => undefined,
    cancelled: async () => undefined,
    superseded: async () => undefined,
    discarded: async (_run, open, { freeTicket }) => {
      discarded.push({ freeTicket, open: open?.step.stepId });
    },
  };
  const deps = {
    runs: runs as WorkflowRunsRepository,
    asks,
    jobs: { requestCancel: vi.fn(async () => ({ status: "requested" })) },
    now: () => NOW,
    log: () => undefined,
  } as unknown as EngineDependencies;
  return { engine: createWorkflowEngine(deps), discarded, a };
}

const waitingStep = (): StoredStepRun =>
  stepRow({
    id: "step-a",
    runId: "run-a",
    stepId: "plan",
    status: "waiting",
    jobId: null,
    output: null,
    ask: serializeAsk(ASKED),
    waitingOnCommentId: "9001",
  });

describe("what a discard does to the ticket of the run (#921)", () => {
  // #921-T95
  it("edits nothing on the ticket for a run that was over, even when another run goes on there", async () => {
    const app = discardHarness({
      a: { status: "succeeded", finishedAt: "2026-11-07T11:00:00.000Z" },
      b: { status: "running" },
    });

    expect(await app.engine.discard("run-a")).toEqual({
      outcome: "discarded",
    });
    expect(app.discarded).toEqual([]);
  });

  // #921-T96
  it("takes the labels off a run that was going on only when no other run that goes on holds the ticket", async () => {
    const alone = discardHarness({
      a: { status: "waiting" },
      aSteps: [waitingStep()],
    });
    await alone.engine.discard("run-a");
    const shared = discardHarness({
      a: { status: "waiting" },
      aSteps: [waitingStep()],
      b: { status: "waiting" },
    });
    await shared.engine.discard("run-a");
    const elsewhere = discardHarness({
      a: { status: "running" },
      b: { status: "running", ticketRef: "github:acme/app#13" },
    });
    await elsewhere.engine.discard("run-a");

    // Its own question is edited either way; the labels go only where nobody else needs them.
    expect(alone.discarded).toEqual([{ freeTicket: true, open: "plan" }]);
    expect(shared.discarded).toEqual([{ freeTicket: false, open: "plan" }]);
    expect(elsewhere.discarded).toEqual([
      { freeTicket: true, open: undefined },
    ]);
  });

  // #921-T97
  it("keeps the labels when it cannot tell whether another run holds the ticket", async () => {
    const app = discardHarness({
      a: { status: "running" },
      lookupFails: true,
    });

    await app.engine.discard("run-a");

    expect(app.discarded).toEqual([{ freeTicket: false, open: undefined }]);
  });
});

describe("a repeated discard (#921)", () => {
  // #921-T98
  it("retries the cleanup of the ticket and says it was discarded already", async () => {
    const app = discardHarness({
      a: { status: "waiting" },
      aSteps: [waitingStep()],
    });
    await app.engine.discard("run-a");
    app.discarded.length = 0;

    const again = await app.engine.discard("run-a");

    expect(again).toEqual({ outcome: "already_discarded" });
    expect(app.discarded).toEqual([{ freeTicket: true, open: "plan" }]);
  });

  // #921-T99
  it("does nothing for a run that was over when it was discarded", async () => {
    const app = discardHarness({
      a: { status: "failed", finishedAt: "2026-11-07T11:00:00.000Z" },
    });
    await app.engine.discard("run-a");

    const again = await app.engine.discard("run-a");

    expect(again).toEqual({ outcome: "already_discarded" });
    expect(app.discarded).toEqual([]);
  });
});
