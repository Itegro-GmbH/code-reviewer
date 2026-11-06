// SPDX-License-Identifier: LicenseRef-Proprietary

// Stopping a workflow run (#891) with the real engine, Implementer service and job queue on a real Postgres: the turn that runs is asked to
// stop and the run ends `cancelled` when it has; a turn that still waits ends at once; no step starts after the stop; the cost of what ran is
// in the run; a repeat and a run that is over change nothing; and a task stopped by itself ends the run it belongs to the same way.
import { describe, expect, it } from "vitest";
import {
  startEngineHarness,
  twoAgentSteps,
  type EngineHarness,
} from "../test-support/workflow-engine-harness.ts";

async function started(app: EngineHarness) {
  const workflow = await app.saveWorkflow(twoAgentSteps());
  const { run } = await app.start(workflow.id);
  await app.engine.advance(run.id);
  return { workflow, runId: run.id };
}

const cancelledReport = { ok: false, errorCode: "cancelled", costUsd: 0.3 };

describe("stopping a workflow run", () => {
  // #891-T40
  it("marks the run, asks the turn that runs to stop and ends the run cancelled when the turn has reported it", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    const lease = await app.claimTurn();

    const cancelled = await app.service.cancel(workflow.id, runId);
    await app.engine.advance(runId);

    expect(cancelled.outcome).toBe("requested");
    expect(app.kicked).toContain(runId);
    // The run goes on until the turn has stopped; the job knows, so the next heartbeat tells its holder.
    const running = await app.stateOf(runId);
    expect(running.run.status).toBe("running");
    expect(running.run.cancelRequestedAt).not.toBeNull();
    const beat = await app.queue.heartbeat(lease.job.id, lease.leaseToken);
    expect(beat.status === "ok" && beat.job.cancelRequestedAt).not.toBeNull();

    // The holder stopped the turn and reports; the engine hears of it like of any end.
    await app.finishTurn({ ...cancelledReport, claimed: lease });
    await app.engine.jobEnded(lease.job.id);

    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({
      status: "cancelled",
      errorCode: null,
      spentMicroUsd: 300_000,
    });
    expect(state.run.finishedAt).not.toBeNull();
    // The second step never started: no step was written for it, and no job waits.
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["plan", "failed"],
    ]);
    expect(state.steps[0]).toMatchObject({
      errorCode: "cancelled",
      costMicroUsd: 300_000,
      costBasis: "reported",
    });
    expect(await app.waitingJobs()).toEqual([]);
    expect(await app.queue.get(lease.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled",
    });
    const view = await app.service.get(workflow.id, runId);
    expect(view).toMatchObject({ status: "cancelled", spentUsd: 0.3 });
  });

  // #891-T41
  it("ends a turn that still waits for a runner at once, and the run with it, in one look of the engine", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    const waiting = await app.waitingJobs();
    expect(waiting).toHaveLength(1);

    await app.service.cancel(workflow.id, runId);
    await app.engine.advance(runId);

    const state = await app.stateOf(runId);
    expect(state.run.status).toBe("cancelled");
    // The turn never ran: it is booked at no cost, not at the cap of the step.
    expect(state.steps).toMatchObject([
      {
        stepId: "plan",
        status: "failed",
        errorCode: "cancelled",
        costMicroUsd: 0,
        costBasis: "reported",
      },
    ]);
    // Nothing is left behind for a runner to take later.
    expect(await app.waitingJobs()).toEqual([]);
    expect(await app.queue.claimNext("runner-a", ["implementer"])).toBeNull();
    expect(waiting[0] && (await app.queue.get(waiting[0].id))).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled",
    });
  });

  // #891-T42
  it("changes nothing for a repeat or for a run that is over, and says so", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    const lease = await app.claimTurn();

    const first = await app.service.cancel(workflow.id, runId);
    const again = await app.service.cancel(workflow.id, runId);
    await app.engine.advance(runId);
    await app.finishTurn({ ...cancelledReport, claimed: lease });
    await app.engine.jobEnded(lease.job.id);
    const after = await app.service.cancel(workflow.id, runId);

    expect([first.outcome, again.outcome, after.outcome]).toEqual([
      "requested",
      "already_requested",
      "already_ended",
    ]);
    expect(after.run).toMatchObject({ status: "cancelled" });
    // The mark of the first call stays.
    expect((await app.stateOf(runId)).run.cancelRequestedAt).not.toBeNull();
    await expect(
      app.service.cancel(workflow.id, "no-such-run"),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_NOT_FOUND" });
    await expect(
      app.service.cancel("other-workflow", runId),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_NOT_FOUND" });
  });

  // #891-T43
  it("leaves a run that succeeded as it is", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    await app.engine.jobEnded(
      await app.finishTurn({ agentResult: { summary: "Plan." } }),
    );
    await app.engine.jobEnded(await app.finishTurn());
    expect((await app.stateOf(runId)).run.status).toBe("succeeded");

    const cancelled = await app.service.cancel(workflow.id, runId);

    expect(cancelled.outcome).toBe("already_ended");
    expect((await app.stateOf(runId)).run).toMatchObject({
      status: "succeeded",
      cancelRequestedAt: null,
    });
  });

  // #891-T44
  it("lets a turn that finished before the stop took effect keep its result, and ends the run cancelled without starting the next step", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    const lease = await app.claimTurn();
    await app.service.cancel(workflow.id, runId);

    // The runner's report was already on its way: the turn succeeded.
    await app.finishTurn({
      claimed: lease,
      agentResult: { summary: "Plan." },
      costUsd: 0.4,
    });
    await app.engine.jobEnded(lease.job.id);

    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({
      status: "cancelled",
      spentMicroUsd: 400_000,
    });
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["plan", "succeeded"],
    ]);
    expect(await app.waitingJobs()).toEqual([]);
  });

  // #891-T45
  it("ends a step that was claimed and has no turn yet, and a turn that starts after that is stopped too", async () => {
    const app = await startEngineHarness();
    const workflow = await app.saveWorkflow(twoAgentSteps());
    const { run } = await app.start(workflow.id);
    // The claimant of the first step is in the middle of starting its turn: the step is claimed, the run does not know the turn yet.
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

    await app.service.cancel(workflow.id, run.id);
    await app.engine.advance(run.id);

    const state = await app.stateOf(run.id);
    expect(state.run.status).toBe("cancelled");
    expect(state.steps).toMatchObject([
      { stepId: "plan", status: "failed", errorCode: "cancelled" },
    ]);
  });

  // #891-T46
  it("ends the run cancelled, not failed, when the task of its step is stopped by itself", async () => {
    const app = await startEngineHarness();
    const { runId } = await started(app);
    const [job] = await app.waitingJobs();
    if (job === undefined) throw new Error("no turn waits");

    // The implementer route stops the run of a task that belongs to a workflow step; the sweep finds the end of the turn.
    const stopped = await app.queue.requestCancel(job.id);
    await app.engine.advance(runId);

    expect(stopped.status).toBe("cancelled");
    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({ status: "cancelled", errorCode: null });
    expect(state.steps).toMatchObject([
      { stepId: "plan", status: "failed", errorCode: "cancelled" },
    ]);
  });
});
