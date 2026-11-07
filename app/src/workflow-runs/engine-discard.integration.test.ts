// SPDX-License-Identifier: LicenseRef-Proprietary

// #921: a member discards a run, whatever state it is in. The engine with the real Implementer service, job queue and a real Postgres: a
// running run stops its turn and is `discarded` at once; a waiting run edits its question and takes its labels off; a run that succeeded
// is discarded as it is; `onFailure` does not run; a repeat changes nothing; the ticket is free for a new run; the old cancel call is the
// same call; and a paused run starts no new step until it is resumed.
import { describe, expect, it } from "vitest";
import {
  startEngineHarness,
  twoAgentSteps,
  type EngineHarness,
} from "../test-support/workflow-engine-harness.ts";
import type { StoredWorkflowRun } from "../db/repositories/workflow-runs-repository.ts";
import { parseStepAsk } from "./ask.ts";
import type { ActionCall } from "./connectors.ts";
import type { AskChannel } from "./engine.ts";

const QUESTION = {
  question: "Retry which failures?",
  options: ["Network errors", "Network errors and 5xx answers"],
};

async function started(app: EngineHarness, document = twoAgentSteps()) {
  const workflow = await app.saveWorkflow(document);
  const { run } = await app.start(workflow.id);
  await app.engine.advance(run.id);
  return { workflow, runId: run.id };
}

function channel() {
  const calls: string[] = [];
  const asks: AskChannel = {
    async asked(run, step, ask) {
      calls.push(`asked ${step.stepId} q${String(ask.n)}`);
      return { commentId: "9001" };
    },
    async answered(run, step) {
      calls.push(`answered ${step.stepId}`);
    },
    async superseded(run, step) {
      calls.push(`superseded ${step.stepId}`);
    },
    async cancelled(run, step) {
      calls.push(`cancelled ${step.stepId}`);
    },
    async discarded(run, open, { freeTicket }) {
      calls.push(
        `${
          open === undefined
            ? "discarded, no open question"
            : `discarded ${open.step.stepId} q${String(open.ask.n)} on ${open.step.waitingOnCommentId ?? "no comment"}`
        }, ticket ${freeTicket ? "freed" : "kept"}`,
      );
    },
  };
  return { asks, calls };
}

describe("discarding a run that runs", () => {
  // #921-T70
  it("is discarded at once, asks the turn that runs to stop, ends its step, and stays discarded when the turn reports", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    const lease = await app.claimTurn();

    const discarded = await app.service.discard(workflow.id, runId);

    expect(discarded.outcome).toBe("discarded");
    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({ status: "discarded", errorCode: null });
    expect(state.run.discardedAt).not.toBeNull();
    expect(state.run.finishedAt).not.toBeNull();
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["plan", "failed"],
    ]);
    expect(state.steps[0]).toMatchObject({ errorCode: "discarded" });
    // The job knows, so the next heartbeat tells its holder to stop.
    const beat = await app.queue.heartbeat(lease.job.id, lease.leaseToken);
    expect(beat.status === "ok" && beat.job.cancelRequestedAt).not.toBeNull();

    // The holder stopped the turn and reports; the engine hears of it and leaves the discarded run as it is.
    await app.finishTurn({
      ok: false,
      errorCode: "cancelled",
      costUsd: 0.3,
      claimed: lease,
    });
    await app.engine.jobEnded(lease.job.id);
    await app.engine.advance(runId);

    const after = await app.stateOf(runId);
    expect(after.run).toMatchObject({ status: "discarded", errorCode: null });
    expect(after.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["plan", "failed"],
    ]);
    expect(await app.waitingJobs()).toEqual([]);
    expect(await app.service.get(workflow.id, runId)).toMatchObject({
      status: "discarded",
    });
  });

  // #921-T71
  it("ends a turn that still waits for a runner at once and leaves nothing for a runner to take", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    const waiting = await app.waitingJobs();
    expect(waiting).toHaveLength(1);

    await app.service.discard(workflow.id, runId);

    expect(await app.waitingJobs()).toEqual([]);
    expect(await app.queue.claimNext("runner-a", ["implementer"])).toBeNull();
    expect(waiting[0] && (await app.queue.get(waiting[0].id))).toMatchObject({
      status: "cancelled",
    });
  });

  // #921-T72
  it("does not write or start another step after the discard", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    const lease = await app.claimTurn();
    await app.service.discard(workflow.id, runId);

    // The report was already on its way: the turn succeeded. It reaches no run any more.
    await app.finishTurn({
      claimed: lease,
      agentResult: { summary: "Plan." },
    });
    await app.engine.jobEnded(lease.job.id);

    const state = await app.stateOf(runId);
    expect(state.run.status).toBe("discarded");
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["plan", "failed"],
    ]);
    expect(await app.waitingJobs()).toEqual([]);
  });

  // #921-T73
  it("ends a step that was claimed and has no turn yet, and a turn that starts after that is stopped too", async () => {
    const app = await startEngineHarness();
    const workflow = await app.saveWorkflow(twoAgentSteps());
    const { run } = await app.start(workflow.id);
    await app.runs.lockRun(run.id, async (lock) => {
      await lock.addStep({
        position: 0,
        stepId: "plan",
        kind: "agent",
        round: 1,
        profile: { name: "worker", version: 1 },
        capMicroUsd: 20_000_000,
      });
    });
    const step = (await app.runs.listSteps(run.id))[0];
    if (step === undefined) throw new Error("the step was not written");
    await app.runs.claimStep(step.id);

    await app.service.discard(workflow.id, run.id);
    await app.engine.advance(run.id);

    const state = await app.stateOf(run.id);
    expect(state.run.status).toBe("discarded");
    expect(state.steps).toMatchObject([
      { stepId: "plan", status: "failed", errorCode: "discarded" },
    ]);
    expect(await app.waitingJobs()).toEqual([]);
  });
});

describe("discarding a run that waits for an answer", () => {
  // #921-T74
  it("edits the question as discarded, takes the labels off, ends the step, and keeps what the asking turn cost", async () => {
    const { asks, calls } = channel();
    const app = await startEngineHarness({ asks });
    const { workflow, runId } = await started(app);
    await app.engine.jobEnded(
      await app.finishTurn({ agentAsk: QUESTION, costUsd: 0.5 }),
    );
    expect((await app.stateOf(runId)).run.status).toBe("waiting");

    const discarded = await app.service.discard(workflow.id, runId);

    expect(discarded.outcome).toBe("discarded");
    // The comment is the one the question was posted as (9001), and the call that edits it also takes the labels off.
    expect(calls).toEqual([
      "asked plan q1",
      "discarded plan q1 on 9001, ticket freed",
    ]);
    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({
      status: "discarded",
      spentMicroUsd: 500_000,
    });
    expect(state.steps[0]).toMatchObject({
      status: "failed",
      errorCode: "discarded",
      costMicroUsd: 500_000,
      costBasis: "reported",
    });
    // The question stays as the agent asked it; nobody can answer it any more.
    expect(parseStepAsk(state.steps[0]?.ask ?? null)).toMatchObject({
      state: "open",
    });
    expect(
      await app.engine.answer(runId, {
        question: { stepRunId: state.steps[0]?.id ?? "none", n: 1 },
        text: "late",
        by: "a",
        via: "ui",
      }),
    ).toEqual({ outcome: "not_waiting" });
    expect(await app.waitingJobs()).toEqual([]);
  });
});

describe("discarding a run that is over", () => {
  // #921-T75
  it("discards a run that succeeded, keeps how it ended, and leaves the ticket alone", async () => {
    const { asks, calls } = channel();
    const app = await startEngineHarness({ asks });
    const { workflow, runId } = await started(app);
    await app.engine.jobEnded(
      await app.finishTurn({ agentResult: { summary: "Plan." } }),
    );
    await app.engine.jobEnded(await app.finishTurn());
    const before = (await app.stateOf(runId)).run;
    expect(before.status).toBe("succeeded");

    const discarded = await app.service.discard(workflow.id, runId);

    expect(discarded.outcome).toBe("discarded");
    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({
      status: "discarded",
      finishedAt: before.finishedAt,
      spentMicroUsd: before.spentMicroUsd,
    });
    expect(state.run.discardedAt).not.toBeNull();
    expect(state.steps.map((step) => step.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    // A run that was over has no label of its own: nothing is edited on the ticket.
    expect(calls).toEqual([]);
  });

  // #921-T76
  it("discards a run that failed and keeps the code that says why", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    await app.engine.jobEnded(
      await app.finishTurn({ ok: false, errorCode: "timeout" }),
    );
    expect((await app.stateOf(runId)).run.status).toBe("failed");

    await app.service.discard(workflow.id, runId);

    expect((await app.stateOf(runId)).run).toMatchObject({
      status: "discarded",
      errorCode: "step_failed",
    });
  });
});

describe("what a discard leaves", () => {
  // #921-T77
  it("changes nothing for a repeat, says so, and finds no run of another workflow or none at all", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);

    const first = await app.service.discard(workflow.id, runId);
    const stamp = (await app.stateOf(runId)).run;
    const again = await app.service.discard(workflow.id, runId);

    expect([first.outcome, again.outcome]).toEqual([
      "discarded",
      "already_discarded",
    ]);
    expect((await app.stateOf(runId)).run).toMatchObject({
      discardedAt: stamp.discardedAt,
      updatedAt: stamp.updatedAt,
    });
    await expect(
      app.service.discard(workflow.id, "no-such-run"),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_NOT_FOUND" });
    await expect(
      app.service.discard("other-workflow", runId),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_NOT_FOUND" });
  });

  // #921-T78
  it("lets the old cancel call do the same: the run is discarded, not cancelled", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);

    const cancelled = await app.service.cancel(workflow.id, runId);

    expect(cancelled.outcome).toBe("discarded");
    expect((await app.stateOf(runId)).run).toMatchObject({
      status: "discarded",
      cancelRequestedAt: null,
    });
  });

  // #921-T79
  it("does not run onFailure: nothing technical failed", async () => {
    const calls: ActionCall[] = [];
    const app = await startEngineHarness({
      connectors: [
        {
          name: "github.issue.comment",
          async run(call: ActionCall) {
            calls.push(call);
            return { url: "https://github.test/comment/1" };
          },
        },
      ],
    });
    const { workflow, runId } = await started(app, {
      ...twoAgentSteps(),
      onFailure: [
        {
          id: "report",
          kind: "action",
          connector: "github.issue.comment",
          issue: 7,
          body: "{{failure.status}}",
        },
      ],
    });
    const lease = await app.claimTurn();

    await app.service.discard(workflow.id, runId);
    await app.finishTurn({
      ok: false,
      errorCode: "cancelled",
      claimed: lease,
    });
    await app.engine.jobEnded(lease.job.id);
    await app.engine.advance(runId);

    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({ status: "discarded", failure: null });
    expect(state.steps.map((step) => step.stepId)).toEqual(["plan"]);
    expect(calls).toEqual([]);
  });

  // #921-T80
  it("frees the ticket: a run of the same workflow for the same key starts once the first is discarded, not before", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    const base = (await app.stateOf(runId)).run;
    const labeled = (clientRequestId: string) =>
      app.runs.createRun({
        workflowId: base.workflowId,
        workflowVersion: base.workflowVersion,
        repositoryId: base.repositoryId,
        baseBranch: "main",
        triggerInput: "{}",
        budgetMicroUsd: 1_000_000,
        clientRequestId,
        triggerKind: "ticket.labeled",
        createdBy: null,
        actorLogin: "octocat",
        triggerKey: "repo-1#12",
        ticketRef: "github:acme/widgets#12",
      });
    const first = await labeled("label-1");
    if (first.status !== "created")
      throw new Error("the first run was refused");
    expect((await labeled("label-2")).status).toBe("busy");

    await app.service.discard(workflow.id, first.run.id);

    expect((await labeled("label-3")).status).toBe("created");
  });
});

/**
 * A run about ticket #12, as the engine writes it: the key is what keeps two of one workflow apart. It starts from the trigger of the base
 * run (the test workflow has no label trigger, and a run whose trigger the document lacks fails as `document_unusable`); the ticket is
 * what the ticket reference names.
 */
async function labeledRun(
  app: EngineHarness,
  base: StoredWorkflowRun,
  key: string,
) {
  const created = await app.runs.createRun({
    workflowId: base.workflowId,
    workflowVersion: base.workflowVersion,
    repositoryId: base.repositoryId,
    baseBranch: "main",
    triggerInput: base.triggerInput,
    budgetMicroUsd: 1_000_000,
    clientRequestId: `label-${key}`,
    triggerKind: base.triggerKind,
    ...(base.triggerId === null ? {} : { triggerId: base.triggerId }),
    createdBy: base.createdBy,
    actorLogin: base.actorLogin,
    triggerKey: key,
    ticketRef: "github:acme/widgets#12",
  });
  if (created.status !== "created") throw new Error("the run was refused");
  return created.run;
}

describe("discarding an old run while a newer one holds the ticket", () => {
  // #921-T100
  it("leaves the labels of the run that goes on, and edits only the question of the run it discards", async () => {
    const { asks, calls } = channel();
    const app = await startEngineHarness({ asks });
    // The first run is only the row the others are copied from: it is never advanced and is about no ticket.
    const workflow = await app.saveWorkflow(twoAgentSteps());
    const base = (await app.stateOf((await app.start(workflow.id)).run.id)).run;
    const older = await labeledRun(app, base, "older");
    await app.engine.advance(older.id);
    await app.engine.jobEnded(
      await app.finishTurn({ agentAsk: QUESTION, costUsd: 0.5 }),
    );
    expect((await app.stateOf(older.id)).run.status).toBe("waiting");
    const newer = await labeledRun(app, base, "newer");

    await app.service.discard(workflow.id, older.id);

    expect(calls.at(-1)).toBe("discarded plan q1 on 9001, ticket kept");
    expect((await app.stateOf(newer.id)).run.status).toBe("running");
  });

  // #921-T101
  it("touches nothing on the ticket when the run it discards was over, whoever holds the ticket", async () => {
    const { asks, calls } = channel();
    const app = await startEngineHarness({ asks });
    // The first run is only the row the others are copied from: it is never advanced and is about no ticket.
    const workflow = await app.saveWorkflow(twoAgentSteps());
    const base = (await app.stateOf((await app.start(workflow.id)).run.id)).run;
    const older = await labeledRun(app, base, "older");
    await app.engine.advance(older.id);
    await app.engine.jobEnded(
      await app.finishTurn({ agentResult: { summary: "Plan." } }),
    );
    await app.engine.jobEnded(await app.finishTurn());
    expect((await app.stateOf(older.id)).run.status).toBe("succeeded");
    await labeledRun(app, base, "newer");

    await app.service.discard(workflow.id, older.id);

    expect(calls).toEqual([]);
  });
});

describe("repeating a discard", () => {
  // #921-T102
  it("retries the cleanup of the ticket that a failure left undone, and keeps saying it was discarded already", async () => {
    const calls: string[] = [];
    let refuse = true;
    const { asks } = channel();
    const app = await startEngineHarness({
      asks: {
        ...asks,
        async discarded(run, open, options) {
          calls.push(
            `${open?.step.stepId ?? "none"} ${options.freeTicket ? "freed" : "kept"}`,
          );
          if (refuse) throw new Error("github down");
        },
      },
    });
    const { workflow, runId } = await started(app);
    await app.engine.jobEnded(
      await app.finishTurn({ agentAsk: QUESTION, costUsd: 0.5 }),
    );

    const first = await app.service.discard(workflow.id, runId);
    refuse = false;
    const again = await app.service.discard(workflow.id, runId);

    expect([first.outcome, again.outcome]).toEqual([
      "discarded",
      "already_discarded",
    ]);
    expect(calls).toEqual(["plan freed", "plan freed"]);
  });

  // #921-T103
  it("does not touch the ticket again for a run that was over when it was discarded", async () => {
    const { asks, calls } = channel();
    const app = await startEngineHarness({ asks });
    const { workflow, runId } = await started(app);
    await app.engine.jobEnded(
      await app.finishTurn({ ok: false, errorCode: "timeout" }),
    );
    // The harness clock stands still; a real discard comes later than the end of the run.
    app.advanceClock(1000);

    await app.service.discard(workflow.id, runId);
    await app.service.discard(workflow.id, runId);

    expect(calls).toEqual([]);
  });
});

describe("pausing a run after its current step", () => {
  // #921-T81
  it("lets the step that runs finish, starts no further step, and starts it when the run is resumed", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);

    const paused = await app.service.pause(workflow.id, runId);
    await app.engine.jobEnded(
      await app.finishTurn({ agentResult: { summary: "Plan." } }),
    );
    await app.engine.advance(runId);

    expect(paused.outcome).toBe("changed");
    expect(paused.run.pauseRequestedAt).not.toBeNull();
    let state = await app.stateOf(runId);
    expect(state.run.status).toBe("running");
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["plan", "succeeded"],
    ]);
    expect(await app.waitingJobs()).toEqual([]);

    const resumed = await app.service.resume(workflow.id, runId);
    await app.engine.advance(runId);

    expect(resumed.outcome).toBe("changed");
    expect(resumed.run.pauseRequestedAt).toBeNull();
    expect(app.kicked).toContain(runId);
    state = await app.stateOf(runId);
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["plan", "succeeded"],
      ["build", "running"],
    ]);
    // The turn of the next step waits for a runner.
    expect(await app.waitingJobs()).toHaveLength(1);
  });

  // #921-T104
  it("drops the request to pause when the run is discarded", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    await app.service.pause(workflow.id, runId);
    expect((await app.stateOf(runId)).run.pauseRequestedAt).not.toBeNull();

    await app.service.discard(workflow.id, runId);

    expect((await app.stateOf(runId)).run).toMatchObject({
      status: "discarded",
      pauseRequestedAt: null,
    });
  });

  // #921-T82
  it("says unchanged for a repeat and for a run that is discarded", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);

    const first = await app.service.pause(workflow.id, runId);
    const again = await app.service.pause(workflow.id, runId);
    await app.service.discard(workflow.id, runId);
    const after = await app.service.pause(workflow.id, runId);
    const resumed = await app.service.resume(workflow.id, runId);

    expect([
      first.outcome,
      again.outcome,
      after.outcome,
      resumed.outcome,
    ]).toEqual(["changed", "unchanged", "unchanged", "unchanged"]);
  });
});
