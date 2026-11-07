// SPDX-License-Identifier: LicenseRef-Proprietary

// #920: an answer on a ticket or a pull request finds the run of the workspace that waits for it, and only that one.
import { describe, expect, it, vi } from "vitest";
import type {
  StoredStepRun,
  StoredWorkflowRun,
} from "../db/repositories/workflow-runs-repository.ts";
import type { TicketAnswer } from "../integrations/types.ts";
import { serializeAsk, type StepAsk } from "./ask.ts";
import type { AnswerResult } from "./engine.ts";
import { createTicketAnswers } from "./ticket-answers.ts";

const REPO = {
  integrationId: "i-1",
  externalId: "repo-1",
  fullName: "acme/widgets",
  url: "https://github.test/acme/widgets",
};

const OPEN: StepAsk = {
  n: 1,
  state: "open",
  question: "Retry which failures?",
  options: ["Network errors", "Network errors and 5xx answers"],
};

function run(id: string, ticket: number | null): StoredWorkflowRun {
  return {
    id,
    workspaceId: "w-1",
    workflowId: "wf-1",
    workflowVersion: 1,
    repositoryId: "r-1",
    baseBranch: "main",
    triggerInput: JSON.stringify(
      ticket === null
        ? { repo: "acme/widgets" }
        : { ticket: { number: ticket }, issue: { number: ticket } },
    ),
    status: "waiting",
    errorCode: null,
    budgetMicroUsd: 1,
    spentMicroUsd: 0,
    clientRequestId: id,
    triggerKind: "ticket.labeled",
    triggerId: null,
    createdBy: null,
    actorLogin: "octocat",
    cancelRequestedAt: null,
    failure: null,
    createdAt: "2026-11-07T08:00:00.000Z",
    updatedAt: "2026-11-07T08:00:00.000Z",
    finishedAt: null,
  };
}

function waitingStep(ask: StepAsk | null): StoredStepRun {
  return {
    id: "s-1",
    runId: "run-1",
    workspaceId: "w-1",
    position: 0,
    stepId: "plan",
    kind: "agent",
    status: "waiting",
    round: 1,
    profile: null,
    jobId: "job-1",
    turnId: "turn-1",
    capMicroUsd: null,
    costMicroUsd: null,
    costBasis: null,
    output: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-11-07T08:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ask: ask === null ? null : serializeAsk(ask),
    waitingOnCommentId: null,
  };
}

const ANSWER: TicketAnswer = {
  repo: REPO,
  number: 7,
  commentId: "9001",
  actor: { login: "octocat", externalId: "1" },
  choice: 2,
  text: "and log it",
  raw: "2 and log it",
};

function harness(options: {
  runs?: StoredWorkflowRun[];
  steps?: Record<string, StoredStepRun[]>;
  active?: boolean;
  result?: AnswerResult;
}) {
  const answer = vi.fn(
    async (): Promise<AnswerResult> =>
      options.result ?? {
        outcome: "answered",
        step: waitingStep(OPEN),
        ask: OPEN,
      },
  );
  const kick = vi.fn();
  const answers = createTicketAnswers({
    activeRepository: async () =>
      options.active === false ? undefined : { id: "r-1" },
    listWaiting: async () => options.runs ?? [run("run-1", 7)],
    listSteps: async (runId) => options.steps?.[runId] ?? [waitingStep(OPEN)],
    engine: { answer },
    kick,
  });
  return { answers, answer, kick };
}

describe("an answer on a ticket", () => {
  // #920-T120
  it("answers the run that waits on that ticket as the commenter, from a comment, and kicks the engine", async () => {
    const { answers, answer, kick } = harness({});

    const taken = await answers.answer("delivery-1", ANSWER);

    expect(taken).toEqual({ outcome: "answered", runId: "run-1" });
    expect(answer).toHaveBeenCalledWith("run-1", {
      choice: 2,
      text: "and log it",
      by: "octocat",
      via: "comment",
    });
    expect(kick).toHaveBeenCalledWith("run-1");
  });

  // #920-T121
  it("takes a number the question has no option for as the start of a free text", async () => {
    const { answers, answer } = harness({
      steps: {
        "run-1": [
          waitingStep({ n: 1, state: "open", question: "Which backoff?" }),
        ],
      },
    });

    await answers.answer("delivery-1", {
      ...ANSWER,
      choice: 3,
      text: "retries",
      raw: "3 retries",
    });

    expect(answer).toHaveBeenCalledWith("run-1", {
      text: "3 retries",
      by: "octocat",
      via: "comment",
    });
  });

  // #920-T122
  it("answers nothing when no run waits on that number, the question was answered, or the repository is not active", async () => {
    for (const options of [
      { runs: [run("run-1", 8)] },
      { runs: [run("run-1", null)] },
      { runs: [] },
      { steps: { "run-1": [waitingStep({ ...OPEN, state: "resumed" })] } },
      { steps: { "run-1": [waitingStep(null)] } },
      { active: false },
    ]) {
      const { answers, answer, kick } = harness(options);

      expect(await answers.answer("d", ANSWER)).toEqual({ outcome: "no_run" });
      expect(answer).not.toHaveBeenCalled();
      expect(kick).not.toHaveBeenCalled();
    }
  });

  // #920-T123
  it("takes the newest waiting run when two wait on the same ticket", async () => {
    const { answers, answer } = harness({
      runs: [run("run-new", 7), run("run-old", 7)],
      steps: { "run-new": [waitingStep(OPEN)], "run-old": [waitingStep(OPEN)] },
    });

    await answers.answer("d", ANSWER);

    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith("run-new", expect.anything());
  });

  // #920-T124
  it("says so when the answer cannot be used or somebody was first, and does not kick", async () => {
    for (const [result, reason] of [
      [{ outcome: "refused", code: "option_unknown" }, "refused"],
      [{ outcome: "not_waiting" }, "not_waiting"],
    ] as const) {
      const { answers, kick } = harness({ result });

      expect(await answers.answer("d", ANSWER)).toEqual({
        outcome: "not_taken",
        reason,
      });
      expect(kick).not.toHaveBeenCalled();
    }
  });

  // #920-T125
  it("finds a pull request the run opened when its trigger has no ticket", async () => {
    const opened: StoredStepRun = {
      ...waitingStep(null),
      id: "s-0",
      position: 0,
      stepId: "open",
      kind: "action",
      status: "succeeded",
      output: JSON.stringify({
        number: 12,
        url: "https://github.test/acme/widgets/pull/12",
      }),
    };
    const { answers, answer } = harness({
      runs: [run("run-1", null)],
      steps: { "run-1": [opened, { ...waitingStep(OPEN), position: 1 }] },
    });

    const taken = await answers.answer("d", { ...ANSWER, number: 12 });

    expect(taken).toEqual({ outcome: "answered", runId: "run-1" });
    expect(answer).toHaveBeenCalled();
  });
});
