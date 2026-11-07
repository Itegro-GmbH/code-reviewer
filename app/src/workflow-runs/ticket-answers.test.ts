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
import {
  ANSWER_REPLIES,
  ASK_TIME_GRACE_MS,
  createTicketAnswers,
  isOlderThanQuestion,
} from "./ticket-answers.ts";

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
    ticketRef: ticket === null ? null : `github:acme/widgets#${ticket}`,
    triggerKind: "ticket.labeled",
    triggerId: null,
    createdBy: null,
    actorLogin: "octocat",
    cancelRequestedAt: null,
    discardedAt: null,
    pauseRequestedAt: null,
    failure: null,
    createdAt: "2026-11-07T08:00:00.000Z",
    updatedAt: "2026-11-07T08:00:00.000Z",
    finishedAt: null,
  };
}

function waitingStep(
  ask: StepAsk | null,
  waitingOnCommentId: string | null = null,
): StoredStepRun {
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
    waitingOnCommentId,
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
  replyFails?: boolean;
  /** Whether the workspace has a run on the repository at all; default yes. */
  hasRuns?: boolean;
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
  const reply = vi.fn(async (...call: unknown[]): Promise<void> => {
    if (options.replyFails === true) throw new Error("GitHub said no");
    expect(call).toHaveLength(4);
  });
  const runs = options.runs ?? [run("run-1", 7)];
  const listWaitingForTicket = vi.fn(async (ticketRef: string) =>
    runs.filter((candidate) => candidate.ticketRef === ticketRef),
  );
  const listWaitingWithoutTicket = vi.fn(async () =>
    runs.filter((candidate) => candidate.ticketRef === null),
  );
  const answers = createTicketAnswers({
    activeRepository: async () =>
      options.active === false ? undefined : { id: "r-1" },
    listWaitingForTicket,
    listWaitingWithoutTicket,
    listSteps: async (runId) => options.steps?.[runId] ?? [waitingStep(OPEN)],
    hasRuns: async () => options.hasRuns !== false,
    engine: { answer },
    kick,
    reply,
  });
  return {
    answers,
    answer,
    kick,
    reply,
    listWaitingForTicket,
    listWaitingWithoutTicket,
  };
}

describe("an answer on a ticket", () => {
  // #920-T120
  it("answers the run that waits on that ticket as the commenter, from a comment, and kicks the engine", async () => {
    const { answers, answer, kick } = harness({});

    const taken = await answers.answer("delivery-1", ANSWER);

    expect(taken).toEqual({ outcome: "answered", runId: "run-1" });
    expect(answer).toHaveBeenCalledWith("run-1", {
      // The answer names the question it was written for; the engine checks it again under the lock of the run.
      question: { stepRunId: "s-1", n: 1 },
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
      question: { stepRunId: "s-1", n: 1 },
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

  // #920-T126
  it("looks the run up by the ticket reference of the comment, and takes no run of another ticket or repository", async () => {
    const { answers, answer, listWaitingForTicket } = harness({
      runs: [
        run("run-other-ticket", 8),
        { ...run("run-other-repo", 7), repositoryId: "r-2" },
        run("run-1", 7),
      ],
      steps: {
        "run-other-ticket": [waitingStep(OPEN)],
        "run-other-repo": [waitingStep(OPEN)],
        "run-1": [waitingStep(OPEN)],
      },
    });

    const taken = await answers.answer("d", ANSWER);

    expect(listWaitingForTicket).toHaveBeenCalledWith("github:acme/widgets#7");
    expect(taken).toEqual({ outcome: "answered", runId: "run-1" });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith("run-1", expect.anything());
  });

  // #920-T124
  it("says so when the answer cannot be used or somebody was first, and does not kick", async () => {
    for (const [result, reason] of [
      [{ outcome: "refused", code: "option_unknown" }, "refused"],
      [{ outcome: "refused", code: "question_changed" }, "refused"],
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

describe("an answer belongs to the question that was open when it was written (#920)", () => {
  const ASKED_AT = "2026-11-07T09:00:00.000Z";
  const asked: StepAsk = { ...OPEN, askedAt: ASKED_AT };

  // #920-T103
  it("takes no comment whose id is not greater than the id of the comment that carries the question", async () => {
    for (const commentId of ["5000", "4999", "17"]) {
      const { answers, answer, kick, reply } = harness({
        steps: { "run-1": [waitingStep(asked, "5000")] },
      });

      expect(await answers.answer("d", { ...ANSWER, commentId })).toEqual({
        outcome: "not_taken",
        reason: "stale",
      });
      expect(answer).not.toHaveBeenCalled();
      expect(kick).not.toHaveBeenCalled();
      // An old comment is nobody's mistake: no reply.
      expect(reply).not.toHaveBeenCalled();
    }
  });

  // #920-T104
  it("takes a comment written after the question, and compares ids as numbers, not as text", async () => {
    // "9001" sorts before "10000" as text and after it as a number.
    const { answers, answer } = harness({
      steps: { "run-1": [waitingStep(asked, "800")] },
    });

    expect(await answers.answer("d", { ...ANSWER, commentId: "9001" })).toEqual(
      { outcome: "answered", runId: "run-1" },
    );
    expect(answer).toHaveBeenCalledTimes(1);

    const second = harness({
      steps: { "run-1": [waitingStep(asked, "10000")] },
    });
    expect(
      await second.answers.answer("d", { ...ANSWER, commentId: "9001" }),
    ).toEqual({ outcome: "not_taken", reason: "stale" });
  });

  // #920-T105
  it("judges a question without a comment by the moment the step began to wait, with a grace for clocks that differ", async () => {
    const { answers, answer } = harness({
      steps: { "run-1": [waitingStep(asked, null)] },
    });

    expect(
      await answers.answer("d", {
        ...ANSWER,
        createdAt: "2026-11-07T08:59:00.000Z",
      }),
    ).toEqual({ outcome: "not_taken", reason: "stale" });
    expect(answer).not.toHaveBeenCalled();

    // 20 seconds before the question: inside the grace, so it counts.
    expect(
      await answers.answer("d", {
        ...ANSWER,
        createdAt: "2026-11-07T08:59:40.000Z",
      }),
    ).toEqual({ outcome: "answered", runId: "run-1" });
  });

  // #920-T106
  it("does not let the redelivery of a comment that found no question answer the question that came later", async () => {
    // The comment (id 9001, written at 08:00) came when nothing waited: no_run, the delivery is released and GitHub may deliver it again.
    const before = harness({ runs: [] });
    const old = { ...ANSWER, createdAt: "2026-11-07T08:00:00.000Z" };
    expect(await before.answers.answer("d", old)).toEqual({
      outcome: "no_run",
    });

    // The next question is asked at 09:00 and its comment has the id 9500: the redelivery is old for it.
    const later = harness({ steps: { "run-1": [waitingStep(asked, "9500")] } });
    expect(await later.answers.answer("d", old)).toEqual({
      outcome: "not_taken",
      reason: "stale",
    });
    expect(later.answer).not.toHaveBeenCalled();
  });

  // #920-T107
  it("goes on to another run on the ticket when the comment is old for the first", async () => {
    const { answers, answer } = harness({
      runs: [run("run-new", 7), run("run-old", 7)],
      steps: {
        "run-new": [waitingStep(asked, "9500")],
        "run-old": [waitingStep(asked, "100")],
      },
    });

    expect(await answers.answer("d", ANSWER)).toEqual({
      outcome: "answered",
      runId: "run-old",
    });
    expect(answer).toHaveBeenCalledWith("run-old", expect.anything());
  });

  // #920-T108
  it("compares only what both sides have: no time, or an id that is no number, leaves the other check to decide", () => {
    const question = { commentId: "5000", ask: { askedAt: ASKED_AT } };
    expect(isOlderThanQuestion({ commentId: "5001" }, question)).toBe(false);
    expect(isOlderThanQuestion({ commentId: "5000" }, question)).toBe(true);
    expect(isOlderThanQuestion({ commentId: "node-77" }, question)).toBe(false);
    expect(
      isOlderThanQuestion(
        { commentId: "5001" },
        { commentId: null, ask: { askedAt: undefined } },
      ),
    ).toBe(false);
    expect(
      isOlderThanQuestion(
        { commentId: "5001", createdAt: "yesterday" },
        { commentId: null, ask: { askedAt: ASKED_AT } },
      ),
    ).toBe(false);
  });

  // #920-T170
  it("lets the ids alone decide when the comment of the question is known, whatever the clocks say", () => {
    const question = { commentId: "5000", ask: { askedAt: ASKED_AT } };
    // Written long before the step began to wait, by the clock, but after the question by id: counts.
    expect(
      isOlderThanQuestion(
        { commentId: "5001", createdAt: "2026-11-06T00:00:00.000Z" },
        question,
      ),
    ).toBe(false);
    // Written long after, by the clock, but before the question by id: old.
    expect(
      isOlderThanQuestion(
        { commentId: "4999", createdAt: "2026-11-08T00:00:00.000Z" },
        question,
      ),
    ).toBe(true);
  });

  // #920-T171
  it("uses the time only without a comment id, and only beyond the grace", () => {
    const question = { commentId: null, ask: { askedAt: ASKED_AT } };
    const at = (offsetMs: number) =>
      new Date(Date.parse(ASKED_AT) + offsetMs).toISOString();
    expect(
      isOlderThanQuestion(
        { commentId: "1", createdAt: at(-ASK_TIME_GRACE_MS - 1000) },
        question,
      ),
    ).toBe(true);
    expect(
      isOlderThanQuestion(
        { commentId: "1", createdAt: at(-ASK_TIME_GRACE_MS + 1000) },
        question,
      ),
    ).toBe(false);
  });
});

describe("a comment that could not answer gets a short reply (#920)", () => {
  // #920-T109
  it("replies in fixed words to an answer that is refused, too long, or came second, and never repeats the comment", async () => {
    for (const [result, text] of [
      [
        { outcome: "refused", code: "answer_empty" },
        ANSWER_REPLIES.answer_empty,
      ],
      [
        { outcome: "refused", code: "answer_too_long" },
        ANSWER_REPLIES.answer_too_long,
      ],
      [
        { outcome: "refused", code: "question_changed" },
        ANSWER_REPLIES.question_changed,
      ],
      [{ outcome: "not_waiting" }, ANSWER_REPLIES.not_waiting],
    ] as const) {
      const { answers, reply } = harness({ result });

      await answers.answer("d", {
        ...ANSWER,
        raw: "secret token ghp_unlikely",
        text: "secret token ghp_unlikely",
      });

      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply).toHaveBeenCalledWith(
        "r-1",
        expect.anything(),
        text,
        "<!-- factory answer-reply comment=9001 -->",
      );
      // What is written is the text and the key only; the comment itself is handed over for the place to write it, not for the words.
      expect(
        JSON.stringify(reply.mock.calls.map((call) => [call[2], call[3]])),
      ).not.toContain("secret token");
    }
  });

  // #920-T110
  it("replies when no question is open on the ticket of an active repository, and stays silent for one that is not active", async () => {
    const open = harness({ runs: [] });
    await open.answers.answer("d", ANSWER);
    expect(open.reply).toHaveBeenCalledWith(
      "r-1",
      expect.anything(),
      ANSWER_REPLIES.no_run,
      expect.any(String),
    );

    const inactive = harness({ active: false });
    await inactive.answers.answer("d", ANSWER);
    expect(inactive.reply).not.toHaveBeenCalled();
  });

  // #920-T172
  it("stays silent on a repository where the workspace never ran a workflow, and replies where runs exist but none waits", async () => {
    const never = harness({ runs: [], hasRuns: false });
    expect(await never.answers.answer("d", ANSWER)).toEqual({
      outcome: "no_run",
    });
    expect(never.reply).not.toHaveBeenCalled();

    const none = harness({ runs: [], hasRuns: true });
    await none.answers.answer("d", ANSWER);
    expect(none.reply).toHaveBeenCalledTimes(1);
  });

  // #920-T111
  it("says nothing for an answer that was taken, and a reply that fails changes nothing", async () => {
    const taken = harness({});
    await taken.answers.answer("d", ANSWER);
    expect(taken.reply).not.toHaveBeenCalled();

    const failing = harness({
      result: { outcome: "not_waiting" },
      replyFails: true,
    });
    expect(await failing.answers.answer("d", ANSWER)).toEqual({
      outcome: "not_taken",
      reason: "not_waiting",
    });
  });
});
