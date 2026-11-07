// SPDX-License-Identifier: LicenseRef-Proprietary

// #920: where the question of an agent is shown and how an answer is acknowledged: the ticket of the run, else its pull request, else nowhere;
// the comment, its edit and the labels go through the App of the workspace and none of them is more than best effort.
import { describe, expect, it, vi } from "vitest";
import type {
  StoredStepRun,
  StoredWorkflowRun,
} from "../db/repositories/workflow-runs-repository.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import type { StepAsk } from "./ask.ts";
import { serializeAsk } from "./ask.ts";
import { createGithubAskChannel } from "./ask-channel.ts";
import { placeOf, pullRequestNumberOf, ticketNumberOf } from "./ask-place.ts";

const REPO: RepoRef = {
  integrationId: "i-1",
  externalId: "repo-1",
  fullName: "acme/widgets",
  url: "https://github.test/acme/widgets",
};
const ASKED: StepAsk = {
  n: 1,
  state: "open",
  question: "Retry which failures?",
  options: ["Network errors", "Network errors and 5xx answers"],
};

function run(
  triggerInput: unknown,
  ticketRef: string | null = null,
): StoredWorkflowRun {
  return {
    id: "run-1",
    workspaceId: "w-1",
    workflowId: "wf-1",
    workflowVersion: 1,
    repositoryId: "r-1",
    baseBranch: "main",
    triggerInput: JSON.stringify(triggerInput),
    status: "waiting",
    errorCode: null,
    budgetMicroUsd: 1,
    spentMicroUsd: 0,
    clientRequestId: "run-1",
    ticketRef,
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

function step(patch: Partial<StoredStepRun> = {}): StoredStepRun {
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
    ask: serializeAsk(ASKED),
    waitingOnCommentId: null,
    ...patch,
  };
}

const opened = (number: number): StoredStepRun =>
  step({
    id: "s-0",
    stepId: "open",
    kind: "action",
    status: "succeeded",
    ask: null,
    output: JSON.stringify({
      number,
      url: `https://github.test/acme/widgets/pull/${String(number)}`,
    }),
  });

describe("where a question is shown", () => {
  // #920-T130
  it("is the ticket of the run, from the input of any trigger that has one", () => {
    expect(
      ticketNumberOf(
        run({ ticket: { number: 7 }, issue: { number: 7 }, repo: {} }),
      ),
    ).toBe(7);
    expect(
      ticketNumberOf(run({ input: { repo: "a/b" }, ticket: { number: 9 } })),
    ).toBe(9);
    expect(ticketNumberOf(run({ issue: { number: 11 } }))).toBe(11);
    expect(ticketNumberOf(run({ repo: "acme/widgets" }))).toBeUndefined();
    expect(ticketNumberOf(run({ ticket: { number: 0 } }))).toBeUndefined();
    expect(
      ticketNumberOf({ ticketRef: null, triggerInput: "not json" }),
    ).toBeUndefined();
  });

  // #920-T132
  it("is the ticket reference of the run when it has one, whatever its input says", () => {
    expect(
      ticketNumberOf(run({ ticket: { number: 7 } }, "github:acme/widgets#12")),
    ).toBe(12);
    expect(
      ticketNumberOf(run({ repo: "acme/widgets" }, "github:acme/widgets#12")),
    ).toBe(12);
    // A reference that is no reference is no ticket: the input is read as for a run written before the column.
    expect(ticketNumberOf(run({ issue: { number: 11 } }, "garbage"))).toBe(11);
    expect(
      placeOf(run({ repo: "x" }, "github:acme/widgets#12"), [opened(5)]),
    ).toEqual({ number: 12, kind: "ticket" });
  });

  // #920-T131
  it("is else the last pull request an action of the run opened, and only a real one", () => {
    expect(pullRequestNumberOf([opened(3), opened(5)])).toBe(5);
    expect(pullRequestNumberOf([step()])).toBeUndefined();
    expect(
      pullRequestNumberOf([
        step({
          kind: "action",
          status: "succeeded",
          output: JSON.stringify({
            number: 4,
            url: "https://github.test/acme/widgets/issues/4",
          }),
        }),
      ]),
    ).toBeUndefined();
    expect(placeOf(run({ ticket: { number: 7 } }), [opened(5)])).toEqual({
      number: 7,
      kind: "ticket",
    });
    expect(placeOf(run({ repo: "x" }), [opened(5)])).toEqual({
      number: 5,
      kind: "pull_request",
    });
    expect(placeOf(run({ repo: "x" }), [])).toBeUndefined();
  });
});

function harness(
  options: { ticket?: boolean; provider?: Partial<IntegrationProvider> } = {},
) {
  type Call = (...call: unknown[]) => Promise<unknown>;
  const commentOnIssue = vi.fn<Call>(async () => ({
    url: "https://github.test/acme/widgets/issues/7#issuecomment-9001",
    existing: false,
    id: "9001",
  }));
  const updateIssueComment = vi.fn<Call>(async () => undefined);
  const changeIssueLabels = vi.fn<Call>(async () => ({ labels: [] }));
  const provider = {
    commentOnIssue,
    updateIssueComment,
    changeIssueLabels,
    ...options.provider,
  } as unknown as IntegrationProvider;
  const channel = createGithubAskChannel({
    targetOf: async () => ({
      provider,
      integration: { id: "i-1" } as unknown as Integration,
      repo: REPO,
    }),
    listSteps: async () => (options.ticket === false ? [opened(12)] : []),
    memberLogins: async () => ["alice", "bob"],
    runLink: async () => "https://app.example/w/acme/workflows/wf-1/runs/run-1",
  });
  const input = run(
    options.ticket === false
      ? { repo: "acme/widgets" }
      : { ticket: { number: 7 } },
  );
  return {
    channel,
    input,
    commentOnIssue,
    updateIssueComment,
    changeIssueLabels,
  };
}

describe("showing a question", () => {
  // #920-T132
  it("writes the comment on the ticket with its marker, then the labels, and returns the id of the comment", async () => {
    const { channel, input, commentOnIssue, changeIssueLabels } = harness();

    const shown = await channel.asked(input, step(), ASKED);

    expect(shown).toEqual({ commentId: "9001" });
    expect(commentOnIssue).toHaveBeenCalledOnce();
    const [, repo, number, body, options] = commentOnIssue.mock
      .calls[0] as unknown as [
      unknown,
      RepoRef,
      number,
      string,
      { marker: string },
    ];
    expect(repo).toBe(REPO);
    expect(number).toBe(7);
    expect(options.marker).toBe("<!-- factory ask run=run-1 step=plan q=1 -->");
    expect(body).toContain(options.marker);
    expect(body).toContain("@alice @bob");
    expect(body).toContain(
      "https://app.example/w/acme/workflows/wf-1/runs/run-1",
    );
    expect(changeIssueLabels).toHaveBeenCalledWith(expect.anything(), REPO, 7, {
      add: ["agent waiting"],
      remove: ["agent working"],
    });
  });

  // #920-T133
  it("writes it on the pull request when the run has no ticket, and nowhere when it has neither", async () => {
    const onPullRequest = harness({ ticket: false });
    await onPullRequest.channel.asked(onPullRequest.input, step(), ASKED);
    expect(onPullRequest.commentOnIssue.mock.calls[0]?.[2]).toBe(12);

    const nowhere = harness();
    const bare = run({ repo: "acme/widgets" });
    expect(await nowhere.channel.asked(bare, step(), ASKED)).toBeUndefined();
    expect(nowhere.commentOnIssue).not.toHaveBeenCalled();
  });

  // #920-T134
  it("is not stopped by a label GitHub refuses: the question is the comment", async () => {
    const { channel, input } = harness({
      provider: {
        changeIssueLabels: async () => {
          throw new Error("no permission");
        },
      },
    });

    expect(await channel.asked(input, step(), ASKED)).toEqual({
      commentId: "9001",
    });
  });

  // #920-T135
  it("lets the failure of the comment itself through, for the engine to log", async () => {
    const { channel, input } = harness({
      provider: {
        commentOnIssue: async () => {
          throw new Error("github down");
        },
      },
    });

    await expect(channel.asked(input, step(), ASKED)).rejects.toThrow(
      "github down",
    );
  });

  // #920-T136
  it("says nothing without a comment id: a comment that was there already comes back with its id, an old provider without one gives none", async () => {
    const { channel, input } = harness({
      provider: {
        commentOnIssue: async () => ({ url: "https://x", existing: true }),
      },
    });

    expect(await channel.asked(input, step(), ASKED)).toBeUndefined();
  });
});

describe("acknowledging an answer", () => {
  const answered: StepAsk = {
    ...ASKED,
    state: "answered",
    answer: {
      text: "Network errors",
      choice: 1,
      by: "octocat",
      via: "comment",
      at: "2026-11-07T10:00:00.000Z",
    },
  };

  // #920-T137
  it("edits the comment of the question to say who answered what and puts the labels back", async () => {
    const {
      channel,
      input,
      updateIssueComment,
      commentOnIssue,
      changeIssueLabels,
    } = harness();

    await channel.answered(
      input,
      step({ waitingOnCommentId: "9001" }),
      answered,
    );

    expect(updateIssueComment).toHaveBeenCalledOnce();
    const [, , commentId, body] = updateIssueComment.mock
      .calls[0] as unknown as [unknown, unknown, string, string];
    expect(commentId).toBe("9001");
    expect(body).toContain("<!-- factory answered run=run-1 step=plan q=1 -->");
    expect(body).toContain("Answered by @octocat: Network errors");
    // A comment `/answer` is the record of the answer itself.
    expect(commentOnIssue).not.toHaveBeenCalled();
    expect(changeIssueLabels).toHaveBeenCalledWith(expect.anything(), REPO, 7, {
      add: ["agent working"],
      remove: ["agent waiting"],
    });
  });

  // #920-T138
  it("writes the answer of the page as a comment in the name of the person, so the ticket holds the record", async () => {
    const { channel, input, commentOnIssue } = harness();

    await channel.answered(input, step({ waitingOnCommentId: "9001" }), {
      ...answered,
      answer: { ...answered.answer!, via: "ui" },
    });

    expect(commentOnIssue).toHaveBeenCalledOnce();
    expect(commentOnIssue.mock.calls[0]?.[3]).toContain(
      "Answer by @octocat: Network errors",
    );
  });

  // #920-T139
  it("skips the edit when the question has no comment, and survives a provider that cannot edit or label", async () => {
    const without = harness();
    await without.channel.answered(without.input, step(), answered);
    expect(without.updateIssueComment).not.toHaveBeenCalled();

    const failing = harness({
      provider: {
        updateIssueComment: async () => {
          throw new Error("gone");
        },
        changeIssueLabels: async () => {
          throw new Error("no permission");
        },
      },
    });
    await expect(
      failing.channel.answered(
        failing.input,
        step({ waitingOnCommentId: "9001" }),
        answered,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("a question that was never posted, and one that was stopped (#920)", () => {
  const answered: StepAsk = {
    ...ASKED,
    state: "answered",
    answer: {
      text: "Network errors",
      choice: 1,
      by: "octocat",
      via: "ui",
      at: "2026-11-07T10:00:00.000Z",
    },
  };

  // #920-T116
  it("posts the answered state, never an open question, when the answer came before the question was posted", async () => {
    const { channel, input, commentOnIssue, updateIssueComment } = harness();

    await channel.answered(input, step(), answered);

    expect(updateIssueComment).not.toHaveBeenCalled();
    // One comment, the answered one: for an answer of the page the record in the name of the person would repeat it.
    expect(commentOnIssue).toHaveBeenCalledOnce();
    const [, , number, body, options] = commentOnIssue.mock
      .calls[0] as unknown as [
      unknown,
      unknown,
      number,
      string,
      { marker: string },
    ];
    expect(number).toBe(7);
    expect(options.marker).toBe(
      "<!-- factory answered run=run-1 step=plan q=1 -->",
    );
    expect(body).toContain(options.marker);
    expect(body).toContain("Answered by @octocat: Network errors");
    expect(body).not.toContain("waits for the answer");
  });

  // #920-T117
  it("marks the comment of the question as cancelled and takes the waiting label off, adding no other", async () => {
    const { channel, input, updateIssueComment, changeIssueLabels } = harness();

    await channel.cancelled(input, step({ waitingOnCommentId: "9001" }), ASKED);

    expect(updateIssueComment).toHaveBeenCalledOnce();
    const [, , commentId, body] = updateIssueComment.mock
      .calls[0] as unknown as [unknown, unknown, string, string];
    expect(commentId).toBe("9001");
    expect(body).toContain(
      "<!-- factory cancelled run=run-1 step=plan q=1 -->",
    );
    expect(body).toContain("cancelled before it was answered");
    expect(body).toContain("Retry which failures?");
    expect(changeIssueLabels).toHaveBeenCalledWith(expect.anything(), REPO, 7, {
      add: [],
      remove: ["agent waiting"],
    });
  });

  // #920-T118
  it("takes the label off a question that has no comment, and survives a provider that cannot edit or label", async () => {
    const without = harness();
    await without.channel.cancelled(without.input, step(), ASKED);
    expect(without.updateIssueComment).not.toHaveBeenCalled();
    expect(without.changeIssueLabels).toHaveBeenCalledOnce();

    const failing = harness({
      provider: {
        updateIssueComment: async () => {
          throw new Error("gone");
        },
        changeIssueLabels: async () => {
          throw new Error("no permission");
        },
      },
    });
    await expect(
      failing.channel.cancelled(
        failing.input,
        step({ waitingOnCommentId: "9001" }),
        ASKED,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("a second comment for the same question (#920)", () => {
  // #920-T180
  it("edits the comment that lost to say another one is the question, repeating nothing of it, and leaves the labels alone", async () => {
    const { channel, input, updateIssueComment, changeIssueLabels } = harness();

    await channel.superseded(input, step(), ASKED, "9002");

    expect(updateIssueComment).toHaveBeenCalledOnce();
    const [, , commentId, body] = updateIssueComment.mock
      .calls[0] as unknown as [unknown, unknown, string, string];
    expect(commentId).toBe("9002");
    expect(body).toContain(
      "<!-- factory superseded run=run-1 step=plan q=1 -->",
    );
    expect(body).toContain("Please answer there");
    expect(body).not.toContain("Retry which failures?");
    expect(changeIssueLabels).not.toHaveBeenCalled();
  });

  // #920-T181
  it("survives a provider that cannot edit, and a run that has no target", async () => {
    const failing = harness({
      provider: {
        updateIssueComment: async () => {
          throw new Error("gone");
        },
      },
    });
    await expect(
      failing.channel.superseded(failing.input, step(), ASKED, "9002"),
    ).resolves.toBeUndefined();
  });
});
