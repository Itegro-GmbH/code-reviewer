// SPDX-License-Identifier: LicenseRef-Proprietary

// #920: a turn ends with `done` or `ask`. The engine with the real Implementer service, job queue and a real Postgres: a question puts the
// step and the run into `waiting` and nothing else runs; an answer (from a comment or from the page) starts the next turn of the same session
// and the step goes on; two answers at once make one turn; a stop ends a waiting run; the budget sees what the asking turn cost.
import { describe, expect, it } from "vitest";
import {
  startEngineHarness,
  twoAgentSteps,
  type EngineHarness,
} from "../test-support/workflow-engine-harness.ts";
import { sha } from "../test-support/jobs.ts";
import { parseStepAsk } from "./ask.ts";
import type { AskChannel } from "./engine.ts";

const QUESTION = {
  question: "Retry which failures?",
  options: ["Network errors", "Network errors and 5xx answers"],
  context: "client.ts tells the two apart.",
};

const REPO = "acme/widgets";

async function started(app: EngineHarness) {
  const workflow = await app.saveWorkflow(twoAgentSteps());
  const { run } = await app.start(workflow.id);
  await app.engine.advance(run.id);
  // The agent pushed its branch before it asked: the turn that goes on starts from its tip, which the Implementer reads from GitHub.
  app.h.fake.addBranch(REPO, `workflow/${run.id}/plan`, sha("c"));
  return { workflow, runId: run.id };
}

async function endTurn(
  app: EngineHarness,
  report: Parameters<EngineHarness["finishTurn"]>[0] = {},
): Promise<string> {
  const jobId = await app.finishTurn(report);
  await app.engine.jobEnded(jobId);
  return jobId;
}

async function instructionOf(app: EngineHarness, jobId: string) {
  return await app.h.db
    .selectFrom("implementer_turns")
    .select(["instruction", "session_id", "number"])
    .where("job_id", "=", jobId)
    .executeTakeFirstOrThrow();
}

function channel() {
  const calls: string[] = [];
  const asks: AskChannel = {
    async asked(run, step, ask) {
      calls.push(`asked ${step.stepId} q${String(ask.n)}`);
      return { commentId: "9001" };
    },
    async answered(run, step, ask) {
      calls.push(`answered ${step.stepId} ${ask.answer?.text ?? ""}`);
    },
  };
  return { asks, calls };
}

describe("a turn that ends with a question", () => {
  // #920-T50
  it("puts the step and the run into waiting, charges the turn, shows the question and runs nothing else", async () => {
    const { asks, calls } = channel();
    const app = await startEngineHarness({ asks });
    const { runId } = await started(app);

    await endTurn(app, { agentAsk: QUESTION, costUsd: 0.5 });
    // Whatever repeats, a waiting run does nothing: the sweep, a late event, a kick.
    await app.engine.advance(runId);
    await app.engine.advance(runId);

    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({
      status: "waiting",
      errorCode: null,
      finishedAt: null,
      spentMicroUsd: 500_000,
    });
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["plan", "waiting"],
    ]);
    const [plan] = state.steps;
    expect(parseStepAsk(plan?.ask ?? null)).toEqual({
      ...QUESTION,
      n: 1,
      state: "open",
    });
    expect(plan).toMatchObject({
      costMicroUsd: 500_000,
      costBasis: "reported",
      finishedAt: null,
      waitingOnCommentId: "9001",
    });
    expect(await app.waitingJobs()).toEqual([]);
    expect(calls).toEqual(["asked plan q1"]);
  });

  // #920-T51
  it("goes on with a new turn of the same session when it is answered, and the answer is its instruction", async () => {
    const { asks, calls } = channel();
    const app = await startEngineHarness({ asks });
    const { runId } = await started(app);
    const first = await endTurn(app, { agentAsk: QUESTION, costUsd: 0.5 });

    const answered = await app.engine.answer(runId, {
      choice: 2,
      text: "and log it",
      by: "octocat",
      via: "comment",
    });
    expect(answered).toMatchObject({ outcome: "answered" });
    await app.engine.advance(runId);

    const state = await app.stateOf(runId);
    expect(state.run.status).toBe("running");
    const [plan] = state.steps;
    expect(plan?.status).toBe("running");
    expect(plan?.jobId).not.toBe(first);
    expect(parseStepAsk(plan?.ask ?? null)).toMatchObject({
      state: "resumed",
      answer: {
        text: "Network errors and 5xx answers\n\nand log it",
        choice: 2,
        by: "octocat",
        via: "comment",
      },
    });
    const before = await instructionOf(app, first);
    const after = await instructionOf(app, plan?.jobId ?? "");
    expect(after.session_id).toBe(before.session_id);
    expect(after.number).toBe(2);
    expect(after.instruction).toContain("You asked: Retry which failures?");
    expect(after.instruction).toContain("Network errors and 5xx answers");
    expect(after.instruction).toContain("and log it");
    expect(calls).toEqual([
      "asked plan q1",
      "answered plan Network errors and 5xx answers\n\nand log it",
    ]);

    // The step reads the new turn like any other: done, and the next step runs.
    await endTurn(app, { agentResult: { summary: "Plan." }, costUsd: 0.25 });
    const done = await app.stateOf(runId);
    expect(done.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["plan", "succeeded"],
      ["build", "running"],
    ]);
    // Both turns are in the cost of the step and of the run, once.
    expect(done.steps[0]?.costMicroUsd).toBe(750_000);
    expect(done.run.spentMicroUsd).toBe(750_000);
  });

  // #920-T52
  it("may ask again after an answer: the second question is number 2", async () => {
    const app = await startEngineHarness();
    const { runId } = await started(app);
    await endTurn(app, { agentAsk: QUESTION });
    await app.engine.answer(runId, { text: "Both.", by: "a", via: "ui" });
    await app.engine.advance(runId);

    await endTurn(app, { agentAsk: { question: "Which backoff?" } });

    const state = await app.stateOf(runId);
    expect(state.run.status).toBe("waiting");
    expect(parseStepAsk(state.steps[0]?.ask ?? null)).toMatchObject({
      question: "Which backoff?",
      n: 2,
      state: "open",
    });
  });

  // #920-T53
  it("takes one answer when two arrive: the second finds the question answered and starts no second turn", async () => {
    const app = await startEngineHarness();
    const { runId } = await started(app);
    await endTurn(app, { agentAsk: QUESTION });

    const results = await Promise.all([
      app.engine.answer(runId, { choice: 1, by: "a", via: "comment" }),
      app.engine.answer(runId, { choice: 2, by: "b", via: "ui" }),
    ]);
    await Promise.all([app.engine.advance(runId), app.engine.advance(runId)]);

    expect(results.map((result) => result.outcome).toSorted()).toEqual([
      "answered",
      "not_waiting",
    ]);
    expect(await app.waitingJobs()).toHaveLength(1);
  });

  // #920-T54
  it("refuses an answer that is empty or names an option that is not there, and keeps waiting", async () => {
    const app = await startEngineHarness();
    const { runId } = await started(app);
    await endTurn(app, { agentAsk: QUESTION });

    expect(await app.engine.answer(runId, { by: "a", via: "ui" })).toEqual({
      outcome: "refused",
      code: "answer_empty",
    });
    expect(
      await app.engine.answer(runId, { choice: 3, by: "a", via: "ui" }),
    ).toEqual({ outcome: "refused", code: "option_unknown" });

    expect((await app.stateOf(runId)).run.status).toBe("waiting");
  });

  // #920-T55
  it("is not answerable when it does not wait: a running run, an answered one, a run that does not exist", async () => {
    const app = await startEngineHarness();
    const { runId } = await started(app);

    expect(
      await app.engine.answer(runId, { text: "x", by: "a", via: "ui" }),
    ).toEqual({ outcome: "not_waiting" });
    expect(
      await app.engine.answer("7f0c1b3e-aaaa-4bbb-8ccc-0123456789ab", {
        text: "x",
        by: "a",
        via: "ui",
      }),
    ).toEqual({ outcome: "not_waiting" });
  });

  // #920-T56
  it("is answered from the page: the service takes the answer, the engine goes on after the kick", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    await endTurn(app, { agentAsk: QUESTION });

    const { run } = await app.service.answer(
      { id: "user-1", githubLogin: "octocat" },
      workflow.id,
      runId,
      { choice: 1 },
    );

    expect(run.status).toBe("running");
    expect(run.steps[0]).toMatchObject({
      status: "running",
      ask: { state: "answered", answer: { by: "octocat", via: "ui" } },
    });
    expect(app.kicked).toContain(runId);
    await app.engine.advance(runId);
    expect((await app.stateOf(runId)).steps[0]?.ask).toContain(
      '"state":"resumed"',
    );
  });

  // #920-T57
  it("is answered through the service only as the routes allow: wrong bodies, a run that does not wait", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    const user = { id: "user-1", githubLogin: "octocat" };

    await expect(
      app.service.answer(user, workflow.id, runId, { text: "x" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_NOT_WAITING" });
    await endTurn(app, { agentAsk: QUESTION });
    await expect(
      app.service.answer(user, workflow.id, runId, { other: 1 }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_REQUEST_INVALID" });
    await expect(
      app.service.answer(user, workflow.id, runId, { choice: "1" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_REQUEST_INVALID" });
    await expect(
      app.service.answer(user, workflow.id, runId, { choice: 7 }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_ANSWER_INVALID" });
    await expect(
      app.service.answer(user, "other-workflow", runId, { choice: 1 }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_NOT_FOUND" });
  });

  // #920-T58
  it("is stopped while it waits: the step ends cancelled and the run cancelled, nothing starts", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await started(app);
    await endTurn(app, { agentAsk: QUESTION });

    const cancelled = await app.service.cancel(workflow.id, runId);
    await app.engine.advance(runId);

    expect(cancelled.outcome).toBe("requested");
    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({ status: "cancelled", errorCode: null });
    expect(state.run.finishedAt).not.toBeNull();
    expect(state.steps[0]).toMatchObject({
      status: "failed",
      errorCode: "cancelled",
    });
    expect(await app.waitingJobs()).toEqual([]);
    expect(
      await app.engine.answer(runId, { text: "late", by: "a", via: "ui" }),
    ).toEqual({ outcome: "not_waiting" });
  });

  // #920-T59
  it("fails the step when the budget cannot pay for the turn that goes on after the answer", async () => {
    const app = await startEngineHarness({ maxBudgetUsd: 1 });
    const workflow = await app.saveWorkflow({
      ...twoAgentSteps(),
      budgetUsd: 1,
    });
    const { run } = await app.start(workflow.id);
    await app.engine.advance(run.id);
    app.h.fake.addBranch(REPO, `workflow/${run.id}/plan`, sha("c"));
    // The asking turn costs the whole budget (the run's budget is one dollar).
    await endTurn(app, { agentAsk: QUESTION, costUsd: 1 });

    await app.engine.answer(run.id, { choice: 1, by: "a", via: "ui" });
    await app.engine.advance(run.id);

    const state = await app.stateOf(run.id);
    expect(state.steps[0]).toMatchObject({
      status: "failed",
      errorCode: "budget_exhausted",
    });
    expect(state.run).toMatchObject({
      status: "failed",
      errorCode: "step_failed",
    });
  });
});
