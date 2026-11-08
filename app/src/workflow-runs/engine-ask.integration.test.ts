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
import { dueWorkflowRuns } from "../db/repositories/workflow-runs-sweep.ts";
import { implementerDeliveryId } from "../db/implementer-job-shape.ts";
import { sha } from "../test-support/jobs.ts";
import { parseStepAsk, type AnswerInput } from "./ask.ts";
import type { AnswerResult, AskChannel } from "./engine.ts";

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

/** The question the run waits for now, as a page that shows it names it. */
async function questionOf(app: EngineHarness, runId: string) {
  const { steps } = await app.stateOf(runId);
  const step =
    steps.findLast((row) => row.status === "waiting") ?? steps.at(-1);
  return {
    stepRunId: step?.id ?? "none",
    n: parseStepAsk(step?.ask ?? null)?.n ?? 1,
  };
}

/** Answers the question that waits now. */
async function answerOf(
  app: EngineHarness,
  runId: string,
  input: AnswerInput & { by: string | null; via: "comment" | "ui" },
): Promise<AnswerResult> {
  return app.engine.answer(runId, {
    ...input,
    question: await questionOf(app, runId),
  });
}

/** Gives the run a ticket: a question is announced again only where there is a ticket (or a pull request) to put it on. */
async function onTicket(app: EngineHarness, runId: string, number = 7) {
  await app.h.db
    .updateTable("workflow_runs")
    .set({ ticket_ref: `github:${REPO}#${String(number)}` })
    .where("id", "=", runId)
    .execute();
}

async function instructionOf(app: EngineHarness, jobId: string) {
  return await app.h.db
    .selectFrom("implementer_turns")
    .select(["instruction", "session_id", "number"])
    .where("job_id", "=", jobId)
    .executeTakeFirstOrThrow();
}

function channel(
  hooks: {
    /** What the post of the question does: throws to fail it, or runs something while "GitHub" takes it. */
    whileAsking?: (call: number) => Promise<string | void>;
  } = {},
) {
  const calls: string[] = [];
  let asked = 0;
  const asks: AskChannel = {
    async asked(run, step, ask) {
      asked += 1;
      calls.push(`asked ${step.stepId} q${String(ask.n)}`);
      const id = await hooks.whileAsking?.(asked);
      return { commentId: id ?? "9001" };
    },
    async answered(run, step, ask) {
      calls.push(
        `answered ${step.stepId} ${ask.answer?.text ?? ""} on ${step.waitingOnCommentId ?? "no comment"}`,
      );
    },
    async superseded(run, step, ask, commentId) {
      calls.push(`superseded ${commentId} of ${step.stepId} q${String(ask.n)}`);
    },
    async cancelled(run, step, ask) {
      calls.push(
        `cancelled ${step.stepId} q${String(ask.n)} on ${step.waitingOnCommentId ?? "no comment"}`,
      );
    },
    async discarded(run, open) {
      calls.push(
        open === undefined
          ? "discarded, no open question"
          : `discarded ${open.step.stepId} q${String(open.ask.n)} on ${open.step.waitingOnCommentId ?? "no comment"}`,
      );
    },
  };
  return { asks, calls };
}

/** The run is asked a first question, answered, and asks a second: the page of the first is still open. */
async function askedTwice() {
  const { asks, calls } = channel();
  const app = await startEngineHarness({ asks });
  const { runId } = await started(app);
  await endTurn(app, { agentAsk: QUESTION });
  const first = await questionOf(app, runId);
  await answerOf(app, runId, { text: "Both.", by: "a", via: "ui" });
  await app.engine.advance(runId);
  await endTurn(app, { agentAsk: { question: "Which backoff?" } });
  return { app, runId, first, calls };
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
      askedAt: expect.any(String) as string,
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

    const answered = await answerOf(app, runId, {
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
      "answered plan Network errors and 5xx answers\n\nand log it on 9001",
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
    await answerOf(app, runId, { text: "Both.", by: "a", via: "ui" });
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
      answerOf(app, runId, { choice: 1, by: "a", via: "comment" }),
      answerOf(app, runId, { choice: 2, by: "b", via: "ui" }),
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

    expect(await answerOf(app, runId, { by: "a", via: "ui" })).toEqual({
      outcome: "refused",
      code: "answer_empty",
    });
    expect(
      await answerOf(app, runId, { choice: 3, by: "a", via: "ui" }),
    ).toEqual({ outcome: "refused", code: "option_unknown" });

    expect((await app.stateOf(runId)).run.status).toBe("waiting");
  });

  // #920-T55
  it("is not answerable when it does not wait: a running run, an answered one, a run that does not exist", async () => {
    const app = await startEngineHarness();
    const { runId } = await started(app);

    expect(
      await answerOf(app, runId, { text: "x", by: "a", via: "ui" }),
    ).toEqual({ outcome: "not_waiting" });
    expect(
      await app.engine.answer("7f0c1b3e-aaaa-4bbb-8ccc-0123456789ab", {
        question: { stepRunId: "none", n: 1 },
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
      { question: await questionOf(app, runId), choice: 1 },
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
    const nothing = { stepRunId: "none", n: 1 };

    await expect(
      app.service.answer(user, workflow.id, runId, {
        question: nothing,
        text: "x",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_NOT_WAITING" });
    await endTurn(app, { agentAsk: QUESTION });
    const question = await questionOf(app, runId);
    await expect(
      app.service.answer(user, workflow.id, runId, { question, other: 1 }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_REQUEST_INVALID" });
    await expect(
      app.service.answer(user, workflow.id, runId, { question, choice: "1" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_REQUEST_INVALID" });
    await expect(
      app.service.answer(user, workflow.id, runId, { question, choice: 7 }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_ANSWER_INVALID" });
    await expect(
      app.service.answer(user, "other-workflow", runId, {
        question,
        choice: 1,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_NOT_FOUND" });
  });

  // #920-T182
  it("takes no answer from the page that does not name its question, or names another one", async () => {
    const { app, runId, first } = await askedTwice();
    const run = await app.stateOf(runId);
    const workflowId = run.run.workflowId;
    const user = { id: "user-1", githubLogin: "octocat" };

    for (const body of [
      { choice: 1 },
      { question: "plan", choice: 1 },
      { question: { stepRunId: first.stepRunId }, choice: 1 },
      { question: { stepRunId: first.stepRunId, n: 1.5 }, choice: 1 },
      { question: { stepRunId: "", n: 1 }, choice: 1 },
    ])
      await expect(
        app.service.answer(user, workflowId, runId, body),
      ).rejects.toMatchObject({ code: "WORKFLOW_RUN_REQUEST_INVALID" });

    // The page of the first question while the second is open.
    await expect(
      app.service.answer(user, workflowId, runId, {
        question: first,
        text: "Both.",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_RUN_QUESTION_CHANGED" });
    expect((await app.stateOf(runId)).run.status).toBe("waiting");
  });

  // #920-T58
  it("is stopped while it waits (the mark of the stop of #891): the step ends cancelled and the run cancelled, nothing starts", async () => {
    const app = await startEngineHarness();
    const { runId } = await started(app);
    await endTurn(app, { agentAsk: QUESTION });

    const marked = await app.runs.lockRun(runId, (lock) =>
      lock.requestCancel(),
    );
    await app.engine.advance(runId);

    expect(marked).toBe(true);
    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({ status: "cancelled", errorCode: null });
    expect(state.run.finishedAt).not.toBeNull();
    expect(state.steps[0]).toMatchObject({
      status: "failed",
      errorCode: "cancelled",
    });
    expect(await app.waitingJobs()).toEqual([]);
    expect(
      await answerOf(app, runId, { text: "late", by: "a", via: "ui" }),
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

    await answerOf(app, run.id, { choice: 1, by: "a", via: "ui" });
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

describe("a question that is not shown yet, a stop, and what a step costs (#920)", () => {
  // #920-T112
  it("shows a question whose post failed at the next look, once: a step with a comment is left alone", async () => {
    const { asks, calls } = channel({
      whileAsking: async (call) => {
        if (call === 1) throw new Error("GitHub is down");
      },
    });
    const app = await startEngineHarness({ asks });
    const { runId } = await started(app);
    await onTicket(app, runId);

    await endTurn(app, { agentAsk: QUESTION });
    expect((await app.stateOf(runId)).steps[0]?.waitingOnCommentId).toBeNull();

    await app.engine.advance(runId);
    expect((await app.stateOf(runId)).steps[0]?.waitingOnCommentId).toBe(
      "9001",
    );
    await app.engine.advance(runId);
    await app.engine.advance(runId);

    expect(calls).toEqual(["asked plan q1", "asked plan q1"]);
    expect((await app.stateOf(runId)).run.status).toBe("waiting");
  });

  // #920-T113
  it("does not leave an open question behind when the answer comes while the question is being posted: the comment is marked answered", async () => {
    let runId = "";
    const holder: { app?: EngineHarness } = {};
    const { asks, calls } = channel({
      whileAsking: async () => {
        const taken =
          holder.app === undefined
            ? undefined
            : await answerOf(holder.app, runId, {
                text: "Use Redis.",
                by: "octocat",
                via: "ui",
              });
        expect(taken?.outcome).toBe("answered");
      },
    });
    const app = await startEngineHarness({ asks });
    holder.app = app;
    ({ runId } = await started(app));

    await endTurn(app, { agentAsk: QUESTION });

    // The answer itself found no comment yet; the post then knew the answer and said so on the comment it had just made.
    expect(calls).toEqual([
      "asked plan q1",
      "answered plan Use Redis. on no comment",
      "answered plan Use Redis. on 9001",
    ]);
    expect((await app.stateOf(runId)).steps[0]).toMatchObject({
      status: "running",
      waitingOnCommentId: "9001",
    });
  });

  // #920-T114
  it("keeps what the asking turns cost when the step fails after the answer: the costs of the steps add up to what the run spent", async () => {
    const app = await startEngineHarness({ maxBudgetUsd: 1 });
    const workflow = await app.saveWorkflow({
      ...twoAgentSteps(),
      budgetUsd: 1,
    });
    const { run } = await app.start(workflow.id);
    await app.engine.advance(run.id);
    app.h.fake.addBranch(REPO, `workflow/${run.id}/plan`, sha("c"));
    await endTurn(app, { agentAsk: QUESTION, costUsd: 1 });
    await answerOf(app, run.id, { choice: 1, by: "a", via: "ui" });
    await app.engine.advance(run.id);

    const state = await app.stateOf(run.id);

    expect(state.steps[0]).toMatchObject({
      status: "failed",
      errorCode: "budget_exhausted",
      costMicroUsd: 1_000_000,
      costBasis: "reported",
    });
    expect(
      state.steps.reduce((sum, step) => sum + (step.costMicroUsd ?? 0), 0),
    ).toBe(state.run.spentMicroUsd);
    expect(state.run.spentMicroUsd).toBe(1_000_000);
  });

  // #920-T115
  it("marks the comment of the question as cancelled when the run is stopped while it waits, and keeps the cost of the turn that asked", async () => {
    const { asks, calls } = channel();
    const app = await startEngineHarness({ asks });
    const { runId } = await started(app);
    await endTurn(app, { agentAsk: QUESTION, costUsd: 0.5 });

    await app.runs.lockRun(runId, (lock) => lock.requestCancel());
    await app.engine.advance(runId);
    await app.engine.advance(runId);

    expect(calls).toEqual(["asked plan q1", "cancelled plan q1 on 9001"]);
    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({
      status: "cancelled",
      spentMicroUsd: 500_000,
    });
    expect(state.steps[0]).toMatchObject({
      status: "failed",
      errorCode: "cancelled",
      costMicroUsd: 500_000,
      costBasis: "reported",
    });
  });

  // #920-T160
  it("takes a waiting run into the sweep only when its question has no comment yet, or a stop is asked for", async () => {
    const { asks } = channel();
    const app = await startEngineHarness({ asks });
    const { runId } = await started(app);
    await onTicket(app, runId);
    const due = () =>
      dueWorkflowRuns(app.h.db, {
        olderThan: "2999-01-01T00:00:00.000Z",
        limit: 10,
      });
    await endTurn(app, { agentAsk: QUESTION });

    // The question has its comment: nothing to look at until somebody answers or stops it.
    expect((await app.stateOf(runId)).steps[0]?.waitingOnCommentId).toBe(
      "9001",
    );
    expect(await due()).toEqual([]);

    // Without a comment (the post failed) the run is looked at again, to post it.
    const [plan] = (await app.stateOf(runId)).steps;
    await app.h.db
      .updateTable("workflow_step_runs")
      .set({ waiting_on_comment_id: null })
      .where("id", "=", plan?.id ?? "")
      .execute();
    expect(await due()).toEqual([{ workspaceId: app.workspaceId, runId }]);
    await app.engine.advance(runId);
    expect(await due()).toEqual([]);

    await app.runs.lockRun(runId, (lock) => lock.requestCancel());
    expect(await due()).toEqual([{ workspaceId: app.workspaceId, runId }]);
  });
});

describe("an answer is for one question, and a question is announced a bounded number of times (#920)", () => {
  // #920-T173
  it("refuses an answer written for the first question while the second is open, and the second still takes its own", async () => {
    const { app, runId, first } = await askedTwice();
    expect(first.n).toBe(1);
    expect(await questionOf(app, runId)).toEqual({
      stepRunId: first.stepRunId,
      n: 2,
    });

    for (const via of ["ui", "comment"] as const) {
      expect(
        await app.engine.answer(runId, {
          question: first,
          text: "Both, said the stale page.",
          by: "a",
          via,
        }),
      ).toEqual({ outcome: "refused", code: "question_changed" });
    }
    // Nothing moved: the second question is open and waits.
    const state = await app.stateOf(runId);
    expect(state.run.status).toBe("waiting");
    expect(parseStepAsk(state.steps[0]?.ask ?? null)).toMatchObject({
      n: 2,
      state: "open",
    });
    expect(await app.waitingJobs()).toEqual([]);

    expect(
      await answerOf(app, runId, { text: "Exponential.", by: "a", via: "ui" }),
    ).toMatchObject({ outcome: "answered" });
  });

  // #920-T174
  it("refuses an answer for another step run than the one that waits, before it looks at the answer itself", async () => {
    const app = await startEngineHarness();
    const { runId } = await started(app);
    await endTurn(app, { agentAsk: QUESTION });
    const { n } = await questionOf(app, runId);

    // An empty text is `answer_empty` for the right question; for another one the question is what is wrong.
    expect(
      await app.engine.answer(runId, {
        question: { stepRunId: "another-step-run", n },
        by: "a",
        via: "ui",
      }),
    ).toEqual({ outcome: "refused", code: "question_changed" });
    expect(await answerOf(app, runId, { by: "a", via: "ui" })).toEqual({
      outcome: "refused",
      code: "answer_empty",
    });
  });

  // #920-T175
  it("takes one answer when a current and a stale page answer at once", async () => {
    const { app, runId, first } = await askedTwice();
    const current = await questionOf(app, runId);

    const results = await Promise.all([
      app.engine.answer(runId, {
        question: first,
        text: "stale",
        by: "a",
        via: "ui",
      }),
      app.engine.answer(runId, {
        question: current,
        text: "current",
        by: "b",
        via: "comment",
      }),
    ]);

    expect(results.map((result) => result.outcome).toSorted()).toEqual([
      "answered",
      "refused",
    ]);
    const answered = parseStepAsk(
      (await app.stateOf(runId)).steps[0]?.ask ?? null,
    );
    expect(answered?.answer?.text).toBe("current");
  });

  // #920-T176
  it("does not announce a question again where the run has no ticket and no pull request: the page shows it", async () => {
    const { asks, calls } = channel({
      whileAsking: async () => {
        throw new Error("no place to post");
      },
    });
    const app = await startEngineHarness({ asks });
    const { runId } = await started(app);

    await endTurn(app, { agentAsk: QUESTION });
    await app.engine.advance(runId);
    await app.engine.advance(runId);

    expect(calls).toEqual(["asked plan q1"]);
    const [plan] = (await app.stateOf(runId)).steps;
    expect(parseStepAsk(plan?.ask ?? null)?.announce).toEqual({
      attempts: 0,
      ended: "no_place",
    });
    // The sweep stops looking at it, so that it does not hold a place among the runs that are due.
    expect(
      await dueWorkflowRuns(app.h.db, {
        olderThan: "2999-01-01T00:00:00.000Z",
        limit: 10,
      }),
    ).toEqual([]);
  });

  // #920-T177
  it("gives up after ten more attempts and writes it on the step, which the page says", async () => {
    const { asks, calls } = channel({
      whileAsking: async () => {
        throw new Error("GitHub is down");
      },
    });
    const app = await startEngineHarness({ asks });
    const { runId } = await started(app);
    await onTicket(app, runId);

    await endTurn(app, { agentAsk: QUESTION });
    for (let look = 0; look < 14; look += 1) await app.engine.advance(runId);

    // The first post, then ten attempts of the sweep; the rest does nothing.
    expect(calls).toHaveLength(11);
    const [plan] = (await app.stateOf(runId)).steps;
    expect(parseStepAsk(plan?.ask ?? null)?.announce).toEqual({
      attempts: 10,
      ended: "gave_up",
    });
    expect((await app.stateOf(runId)).run.status).toBe("waiting");
    expect(
      await dueWorkflowRuns(app.h.db, {
        olderThan: "2999-01-01T00:00:00.000Z",
        limit: 10,
      }),
    ).toEqual([]);
    // The question can still be answered, on the page.
    expect(
      await answerOf(app, runId, { text: "Both.", by: "a", via: "ui" }),
    ).toMatchObject({ outcome: "answered" });
  });

  // #920-T178
  it("gives up when the question was asked more than an hour ago, without another attempt", async () => {
    const { asks, calls } = channel({
      whileAsking: async () => {
        throw new Error("GitHub is down");
      },
    });
    const app = await startEngineHarness({ asks });
    const { runId } = await started(app);
    await onTicket(app, runId);
    await endTurn(app, { agentAsk: QUESTION });
    const [plan] = (await app.stateOf(runId)).steps;
    const ask = parseStepAsk(plan?.ask ?? null);
    await app.h.db
      .updateTable("workflow_step_runs")
      .set({
        ask: JSON.stringify({
          ...ask,
          // The clock of the engine is the harness's, so the moment is taken from the question itself.
          askedAt: new Date(
            Date.parse(ask?.askedAt ?? "") - 61 * 60 * 1000,
          ).toISOString(),
        }),
      })
      .where("id", "=", plan?.id ?? "")
      .execute();

    await app.engine.advance(runId);

    expect(calls).toEqual(["asked plan q1"]);
    const [after] = (await app.stateOf(runId)).steps;
    expect(parseStepAsk(after?.ask ?? null)?.announce).toMatchObject({
      ended: "gave_up",
    });
  });

  // #920-T179
  it("keeps one comment for the question when two announcements post at once: the other is marked superseded", async () => {
    let runId = "";
    const holder: { app?: EngineHarness } = {};
    const { asks, calls } = channel({
      whileAsking: async (call) => {
        // While the first post is under way, another look at the run posts its own comment, and records it first.
        if (call === 1 && holder.app !== undefined)
          await holder.app.engine.advance(runId);
        return call === 2 ? "9002" : undefined;
      },
    });
    const app = await startEngineHarness({ asks });
    holder.app = app;
    ({ runId } = await started(app));
    await onTicket(app, runId);

    await endTurn(app, { agentAsk: QUESTION });

    expect(calls).toEqual([
      "asked plan q1",
      "asked plan q1",
      "superseded 9001 of plan q1",
    ]);
    expect((await app.stateOf(runId)).steps[0]?.waitingOnCommentId).toBe(
      "9002",
    );
  });

  // #920-T186
  it("vouches for a turn only when the step has no job yet, or this one, or the answer to its open question is what asks", async () => {
    const app = await startEngineHarness();
    const { runId } = await started(app);
    const delivery = (requestId: string) =>
      implementerDeliveryId(app.workspaceId, requestId);
    const vouches = (requestId: string, jobId: string) =>
      app.runs.isAgentStepDelivery(delivery(requestId), jobId);
    const first = (await app.stateOf(runId)).steps[0]?.jobId ?? "";
    expect(first).not.toBe("");

    // The first turn: its own job, not another one, not another position or run, not a question that was never answered.
    expect(await vouches(`wf-${runId}-0`, first)).toBe(true);
    expect(await vouches(`wf-${runId}-0`, "another-job")).toBe(false);
    expect(await vouches(`wf-${runId}-1`, first)).toBe(false);
    expect(await vouches(`wf-another-run-0`, first)).toBe(false);
    expect(await vouches(`wf-${runId}-0-q1`, "another-job")).toBe(false);
    expect(await vouches(`request-${runId}-0`, first)).toBe(false);
    expect(
      await app.runs.isAgentStepDelivery(
        `implementer:other:wf-${runId}-0`,
        first,
      ),
    ).toBe(false);

    await endTurn(app, { agentAsk: QUESTION });
    await answerOf(app, runId, { text: "Both.", by: "a", via: "ui" });
    // Answered, the turn that goes on is not started: the step still holds the first job, and the question that was answered asks.
    expect(await vouches(`wf-${runId}-0-q1`, "next-job")).toBe(true);
    expect(await vouches(`wf-${runId}-0-q2`, "next-job")).toBe(false);
    expect(await vouches(`wf-${runId}-0`, "next-job")).toBe(false);

    await app.engine.advance(runId);
    const next = (await app.stateOf(runId)).steps[0]?.jobId ?? "";
    expect(next).not.toBe(first);
    expect(await vouches(`wf-${runId}-0-q1`, next)).toBe(true);
    expect(await vouches(`wf-${runId}-0-q1`, "forged-job")).toBe(false);
    expect(await vouches(`wf-${runId}-0`, first)).toBe(false);
  });
});
