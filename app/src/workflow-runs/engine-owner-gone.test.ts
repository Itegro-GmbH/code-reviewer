// SPDX-License-Identifier: LicenseRef-Proprietary

// #892: a step that goes on in an earlier session (`session.continue`) and waits with its own queued instruction ends without its
// turn when the workflow owner has left the workspace. Whatever ends it, its queued instruction is discarded first: left in the
// session, the next end of a turn would start it with no step to read it and no budget behind it.
import { describe, expect, it, vi } from "vitest";
import type {
  StepOutcome,
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import { ImplementerError } from "../implementer/errors.ts";
import { createConnectorRegistry } from "./connectors.ts";
import { createWorkflowEngine, type EngineDependencies } from "./engine.ts";
import { WORKFLOW_OWNER_GONE_TEXT } from "./errors.ts";
import { STEP_STALE_MS } from "./limits.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");
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
    createdAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    startedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

/**
 * A run a label started whose second step waits: claimed ten minutes ago (past the stale time, short of the give-up time) with its
 * instruction queued behind a turn of the session the first step started.
 */
function harness(options: {
  ownerIsMember: boolean;
  /** Whether the waiting step goes on in the session of the first one; default yes. */
  continues?: boolean;
  continueSession?: EngineDependencies["implementer"]["continueSession"];
  startedMeanwhile?: { jobId: string; turnId: string };
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
    createdBy: null,
    actorLogin: "octocat",
    cancelRequestedAt: null,
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
    }),
  ];
  const settled: Array<{ id: string; outcome: StepOutcome }> = [];
  const attached: Array<{ id: string; jobId: string }> = [];
  const order: string[] = [];
  const stale = new Date(NOW.getTime() - STEP_STALE_MS - 1).toISOString();
  const waiting = steps[1];
  if (waiting === undefined) throw new Error("unreachable");
  waiting.startedAt = stale;

  const attachTurn = async (
    id: string,
    turn: { jobId: string; turnId: string | null },
  ): Promise<boolean> => {
    attached.push({ id, jobId: turn.jobId });
    waiting.jobId = turn.jobId;
    return true;
  };
  const runs: Partial<WorkflowRunsRepository> = {
    getRun: async () => run,
    listSteps: async () => steps.map((step) => ({ ...step })),
    claimStep: async () => ({ ...waiting }),
    settleOwnStep: async (id, outcome) => {
      order.push("settle");
      waiting.status = "failed";
      settled.push({ id, outcome });
      return true;
    },
    attachTurn,
    lockRun: async (_runId, work) =>
      work({
        run,
        steps,
        attachTurn,
        addStep: vi.fn(),
        addFinished: vi.fn(),
        finishStep: vi.fn(),
        finishRun: vi.fn(),
        touch: vi.fn(),
      } as never),
  };
  const discardRequested = vi.fn<
    EngineDependencies["implementer"]["discardRequested"]
  >(async () => {
    order.push("discard");
    return true;
  });
  const deps: EngineDependencies = {
    runs: runs as WorkflowRunsRepository,
    workflows: {
      getVersion: async () =>
        ({
          document: JSON.stringify(documentOf(options.continues ?? true)),
          createdBy: "owner-1",
        }) as never,
    },
    members: {
      get: async () => (options.ownerIsMember ? ({} as never) : undefined),
    },
    profiles: { findByName: async () => undefined },
    environments: {
      listSummaries: async () => [{ id: "env-1", name: "Python" } as never],
    },
    implementer: {
      startTask: vi.fn(),
      continueSession:
        options.continueSession ??
        (async () => {
          throw new Error("not reached");
        }),
      discardRequested,
    },
    jobs: { requestCancel: vi.fn() },
    turns: {
      // The first step's turn is over; the turn the instruction started in the meantime still runs.
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
      findByRequest: async (requestId) => {
        order.push("find");
        if (requestId !== REQUEST_ID || options.startedMeanwhile === undefined)
          return undefined;
        return { ...options.startedMeanwhile, ended: undefined };
      },
    },
    connectors: createConnectorRegistry(),
    repositoryName: async () => "acme/app",
    now: () => NOW,
    log: () => undefined,
  };
  return {
    engine: createWorkflowEngine(deps),
    settled,
    attached,
    order,
    discardRequested,
  };
}

describe("a waiting session.continue step that ends without its turn", () => {
  // #892-T01
  it("discards its own queued instruction when the workflow owner has left the workspace", async () => {
    const app = harness({ ownerIsMember: false });

    await app.engine.advance(RUN_ID);

    expect(app.discardRequested).toHaveBeenCalledWith(SESSION_ID, REQUEST_ID);
    expect(app.settled).toEqual([
      {
        id: "step-1",
        outcome: expect.objectContaining({
          status: "failed",
          errorCode: "agent_start_failed",
          errorMessage: WORKFLOW_OWNER_GONE_TEXT,
        }),
      },
    ]);
    // Discarded before the step ends, so no end of a turn can start it in between.
    expect(app.order).toEqual(["find", "discard", "find", "settle"]);
  });

  // #892-T02
  it("goes on with the turn the instruction started in the meantime instead of failing the step", async () => {
    const app = harness({
      ownerIsMember: false,
      startedMeanwhile: { jobId: "job-fix", turnId: "turn-fix" },
    });

    await app.engine.advance(RUN_ID);

    expect(app.settled).toEqual([]);
    expect(app.attached).toEqual([{ id: "step-1", jobId: "job-fix" }]);
  });

  // #892-T03
  it("discards its own queued instruction when the Implementer refuses the repeat of the request", async () => {
    const app = harness({
      ownerIsMember: true,
      continueSession: async () => {
        throw new ImplementerError(
          "IMPLEMENTER_BRANCH_GONE",
          "The branch of this session is no longer on GitHub.",
        );
      },
    });

    await app.engine.advance(RUN_ID);

    expect(app.discardRequested).toHaveBeenCalledWith(SESSION_ID, REQUEST_ID);
    expect(app.settled).toHaveLength(1);
    // The refused request looks for its turn once (as it always did), the end of the step once more after the discard.
    expect(app.order).toEqual(["find", "find", "discard", "find", "settle"]);
  });

  // #892-T04
  it("leaves a step that does not continue a session alone", async () => {
    // A step in a session of its own queued nothing anywhere.
    const app = harness({ ownerIsMember: false, continues: false });

    await app.engine.advance(RUN_ID);

    expect(app.discardRequested).not.toHaveBeenCalled();
    expect(app.settled).toHaveLength(1);
  });
});
