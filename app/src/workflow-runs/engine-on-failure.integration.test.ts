// SPDX-License-Identifier: LicenseRef-Proprietary

// #902: `onFailure` with the real engine, Implementer service and job queue on a real Postgres. A turn that fails, or that is stopped by a
// member, leaves the run `running` while the comment of `onFailure` is written, stores how the run ends with the run, and ends it `failed`
// or `cancelled`; a run that succeeds never writes it.
import { describe, expect, it } from "vitest";
import type { ActionCall } from "./connectors.ts";
import {
  startEngineHarness,
  twoAgentSteps,
} from "../test-support/workflow-engine-harness.ts";

function withCleanup(): Record<string, unknown> {
  return {
    ...twoAgentSteps(),
    onFailure: [
      {
        id: "report",
        kind: "action",
        connector: "github.issue.comment",
        issue: 7,
        body: "{{failure.status}} at {{failure.stepId}} ({{failure.code}}): {{failure.message}}",
      },
    ],
  };
}

function recorder() {
  const calls: ActionCall[] = [];
  return {
    calls,
    connector: {
      name: "github.issue.comment",
      async run(call: ActionCall) {
        calls.push(call);
        return { url: "https://github.test/comment/1" };
      },
    },
  };
}

describe("the steps of onFailure", () => {
  // #902-T70
  it("comment after a step failed, keep the status failed, and leave the stored failure with the run", async () => {
    const comments = recorder();
    const app = await startEngineHarness({ connectors: [comments.connector] });
    const workflow = await app.saveWorkflow(withCleanup());
    const { run } = await app.start(workflow.id);
    await app.engine.advance(run.id);

    await app.engine.jobEnded(
      await app.finishTurn({ ok: false, errorCode: "timeout", costUsd: 0.2 }),
    );

    const state = await app.stateOf(run.id);
    expect(state.run).toMatchObject({
      status: "failed",
      errorCode: "step_failed",
      spentMicroUsd: 200_000,
    });
    expect(JSON.parse(state.run.failure ?? "null")).toMatchObject({
      status: "failed",
      stepId: "plan",
      code: "timeout",
    });
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["plan", "failed"],
      ["report", "succeeded"],
    ]);
    expect(comments.calls).toHaveLength(1);
    expect(comments.calls[0]?.inputs).toMatchObject({
      issue: 7,
      body: expect.stringContaining(
        "failed at plan (timeout)",
      ) as unknown as string,
    });
    // The second agent step never started, and the comment cost nothing.
    expect(await app.waitingJobs()).toEqual([]);
  });

  // #902-T71
  it("comment after a run that carries the mark of the stop of #891, once the agent has stopped, and end it cancelled", async () => {
    const comments = recorder();
    const app = await startEngineHarness({ connectors: [comments.connector] });
    const workflow = await app.saveWorkflow(withCleanup());
    const { run } = await app.start(workflow.id);
    await app.engine.advance(run.id);
    const lease = await app.claimTurn();

    await app.runs.lockRun(run.id, (lock) => lock.requestCancel());
    await app.engine.advance(run.id);
    expect(comments.calls).toHaveLength(0);
    expect((await app.stateOf(run.id)).run.status).toBe("running");

    await app.finishTurn({ ok: false, errorCode: "cancelled", claimed: lease });
    await app.engine.jobEnded(lease.job.id);

    const state = await app.stateOf(run.id);
    expect(state.run).toMatchObject({ status: "cancelled", errorCode: null });
    expect(comments.calls).toHaveLength(1);
    expect(comments.calls[0]?.inputs).toMatchObject({
      body: expect.stringContaining(
        "cancelled at plan (cancelled)",
      ) as unknown as string,
    });
  });

  // #902-T72
  it("do not run after a run that succeeded", async () => {
    const comments = recorder();
    const app = await startEngineHarness({ connectors: [comments.connector] });
    const workflow = await app.saveWorkflow(withCleanup());
    const { run } = await app.start(workflow.id);
    await app.engine.advance(run.id);

    await app.engine.jobEnded(
      await app.finishTurn({ agentResult: { summary: "Plan." } }),
    );
    await app.engine.jobEnded(await app.finishTurn());

    const state = await app.stateOf(run.id);
    expect(state.run).toMatchObject({ status: "succeeded", failure: null });
    expect(comments.calls).toEqual([]);
  });
});
