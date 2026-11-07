// SPDX-License-Identifier: LicenseRef-Proprietary

// #924: the ToDos are a query over the runs and the ticket mirror: a question is a run that waits with an open ask, a review is an open
// pull request a lane opened and a review is asked for, and the done list holds the last answers and the finished reviews.
import { describe, expect, it } from "vitest";
import type {
  StoredStepRun,
  StoredWorkflowRun,
} from "../db/repositories/workflow-runs-repository.ts";
import type { TrackerItem } from "../db/repositories/tracker-repository.ts";
import { serializeAsk, type StepAsk } from "../workflow-runs/ask.ts";
import { TodosError } from "./errors.ts";
import {
  createTodosService,
  DONE_MAX,
  type TodosServiceDependencies,
} from "./service.ts";

const T = (minute: number) =>
  new Date(Date.UTC(2026, 10, 7, 9, minute)).toISOString();

function run(
  id: string,
  over: Partial<StoredWorkflowRun> = {},
): StoredWorkflowRun {
  return {
    id,
    workspaceId: "w-1",
    workflowId: "wf-1",
    workflowVersion: 1,
    repositoryId: "r-1",
    baseBranch: "main",
    triggerInput: "{}",
    status: "waiting",
    errorCode: null,
    budgetMicroUsd: 5_000_000,
    spentMicroUsd: 1_250_000,
    clientRequestId: id,
    ticketRef: "github:acme/widgets#12",
    triggerKind: "ticket.labeled",
    triggerId: null,
    createdBy: null,
    actorLogin: "octocat",
    cancelRequestedAt: null,
    failure: null,
    createdAt: T(0),
    updatedAt: T(5),
    finishedAt: null,
    ...over,
  };
}

function step(
  runId: string,
  over: Omit<Partial<StoredStepRun>, "ask"> & { ask?: StepAsk | null } = {},
): StoredStepRun {
  const { ask, ...rest } = over;
  return {
    id: `${runId}-s`,
    runId,
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
    createdAt: T(1),
    startedAt: null,
    finishedAt: null,
    ask:
      ask === null
        ? null
        : serializeAsk(
            ask ?? {
              n: 1,
              state: "open",
              question: "Retry which failures?",
              options: ["Network errors", "Network errors and 5xx"],
              askedAt: T(4),
            },
          ),
    waitingOnCommentId: null,
    ...rest,
  };
}

const prStep = (runId: string, number: number): StoredStepRun =>
  step(runId, {
    id: `${runId}-pr`,
    kind: "action",
    status: "succeeded",
    ask: null,
    output: JSON.stringify({
      number,
      url: `https://github.test/acme/widgets/pull/${String(number)}`,
    }),
  });

function item(number: number, over: Partial<TrackerItem> = {}): TrackerItem {
  return {
    repositoryId: "r-1",
    projectId: "p-1",
    provider: "github",
    repo: "acme/widgets",
    number,
    nodeId: `N_${String(number)}`,
    kind: "issue",
    state: "open",
    stateReason: null,
    type: null,
    title: `Ticket ${String(number)}`,
    bodyExcerpt: "",
    labels: [],
    assignees: [],
    boardStatus: null,
    parentNumber: null,
    pullRequests: [],
    closes: [],
    checksState: null,
    reviewRequestedFrom: [],
    updatedAt: T(3),
    syncedAt: T(3),
    ...over,
  };
}

type World = {
  waiting?: StoredWorkflowRun[];
  steps?: Record<string, StoredStepRun[]>;
  answered?: { run: StoredWorkflowRun; step: StoredStepRun }[];
  prSteps?: { run: StoredWorkflowRun; step: StoredStepRun }[];
  items?: TrackerItem[];
  members?: string[];
  /** Lanes: id → name and project. Default: one lane of project p-1. */
  lanes?: Record<string, { name: string; projectId: string | null }>;
};

function service(world: World = {}) {
  const lanes = world.lanes ?? {
    "wf-1": { name: "Implement", projectId: "p-1" },
  };
  const deps: TodosServiceDependencies = {
    projects: {
      async listProjects() {
        return [
          {
            repository: {
              id: "r-1",
              externalId: "ext-1",
              fullName: "acme/widgets",
              url: "https://github.test/acme/widgets",
              available: true,
              integration: {
                id: "i-1",
                type: "github_app",
                displayName: "acme",
                status: "active",
              },
            },
            project: {
              id: "p-1",
              repositoryId: "r-1",
              active: true,
              ticketSource: {
                provider: "github",
                repositoryId: "r-1",
                board: null,
              },
              settings: {},
              createdAt: T(0),
              updatedAt: T(0),
            },
            status: "active",
          },
          {
            repository: {
              id: "r-2",
              externalId: "ext-2",
              fullName: "acme/gadgets",
              url: "https://github.test/acme/gadgets",
              available: true,
              integration: {
                id: "i-1",
                type: "github_app",
                displayName: "acme",
                status: "active",
              },
            },
            project: {
              id: "p-2",
              repositoryId: "r-2",
              active: true,
              ticketSource: {
                provider: "github",
                repositoryId: "r-2",
                board: null,
              },
              settings: {},
              createdAt: T(0),
              updatedAt: T(0),
            },
            status: "active",
          },
        ];
      },
    },
    workflows: {
      async list() {
        return Object.entries(lanes).map(([id, lane]) => ({
          id,
          workspaceId: "w-1",
          projectId: lane.projectId,
          name: lane.name,
          version: 1,
          createdBy: "u-1",
          createdAt: T(0),
          updatedAt: T(0),
          archivedAt: null,
        }));
      },
    },
    runs: {
      async listWaiting() {
        return world.waiting ?? [];
      },
      async listSteps(runId) {
        return world.steps?.[runId] ?? [];
      },
      async listAnsweredAskSteps() {
        return world.answered ?? [];
      },
      async listPullRequestSteps() {
        return world.prSteps ?? [];
      },
    },
    tracker: {
      async listItemsByNumbers(repositoryId, numbers) {
        return (world.items ?? []).filter(
          (candidate) =>
            candidate.repositoryId === repositoryId &&
            numbers.includes(candidate.number),
        );
      },
    },
    memberLogins: async () => world.members ?? ["alice", "bob"],
  };
  return createTodosService(deps);
}

describe("the questions of agents", () => {
  // #924-T10
  it("lists a run that waits with its open question, options, since when, spent of the budget and its ticket", async () => {
    const todos = service({
      waiting: [run("run-1")],
      steps: { "run-1": [step("run-1")] },
      items: [
        item(12, {
          labels: [{ name: "agent waiting", color: "fbca04" }],
          title: "Cache the widget list",
        }),
      ],
    });

    const list = await todos.list({ githubLogin: "alice" });

    expect(list.projectId).toBeNull();
    expect(list.questions).toEqual([
      {
        kind: "question",
        id: "question:run-1:run-1-s:1",
        projectId: "p-1",
        repositoryId: "r-1",
        repo: "acme/widgets",
        runId: "run-1",
        workflowId: "wf-1",
        lane: "Implement",
        stepRunId: "run-1-s",
        stepId: "plan",
        n: 1,
        question: "Retry which failures?",
        context: null,
        options: ["Network errors", "Network errors and 5xx"],
        since: T(4),
        spentUsd: 1.25,
        budgetUsd: 5,
        ticket: {
          number: 12,
          kind: "issue",
          title: "Cache the widget list",
          url: "https://github.test/acme/widgets/issues/12",
          labelled: true,
        },
      },
    ]);
  });

  // #924-T11
  it("still lists the question when the mirror does not hold the ticket or the label is missing", async () => {
    const todos = service({
      waiting: [
        run("run-1"),
        run("run-2", { ticketRef: "github:acme/widgets#13" }),
      ],
      steps: {
        "run-1": [step("run-1")],
        "run-2": [step("run-2")],
      },
      items: [item(13)],
    });

    const list = await todos.list({ githubLogin: null });

    const byRun = new Map(list.questions.map((todo) => [todo.runId, todo]));
    expect(byRun.get("run-1")?.ticket).toEqual({
      number: 12,
      kind: "issue",
      title: null,
      url: "https://github.test/acme/widgets/issues/12",
      labelled: false,
    });
    expect(byRun.get("run-2")?.ticket).toMatchObject({
      number: 13,
      title: "Ticket 13",
      labelled: false,
    });
  });

  // #924-T12
  it("leaves out a run whose question is not open, and a run that is not waiting for a step", async () => {
    const answered = step("run-1", {
      ask: {
        n: 1,
        state: "answered",
        question: "q?",
        answer: { text: "a", by: "alice", via: "ui", at: T(6) },
      },
    });
    const todos = service({
      waiting: [run("run-1"), run("run-2")],
      steps: { "run-1": [answered], "run-2": [] },
    });

    expect((await todos.list({ githubLogin: "alice" })).questions).toEqual([]);
  });

  // #924-T13
  it("orders the questions by how long they wait, the newest first, and tells the pull request of a run that has no ticket", async () => {
    const noTicket = run("run-2", {
      ticketRef: null,
      repositoryId: "r-1",
    });
    const todos = service({
      waiting: [run("run-1"), noTicket],
      steps: {
        "run-1": [
          step("run-1", {
            ask: { n: 1, state: "open", question: "first?", askedAt: T(2) },
          }),
        ],
        "run-2": [
          prStep("run-2", 40),
          step("run-2", {
            id: "run-2-ask",
            position: 1,
            ask: { n: 2, state: "open", question: "second?", askedAt: T(8) },
          }),
        ],
      },
      items: [item(40, { kind: "pull_request", title: "A pull request" })],
    });

    const list = await todos.list({ githubLogin: "alice" });

    expect(list.questions.map((todo) => todo.question)).toEqual([
      "second?",
      "first?",
    ]);
    expect(list.questions[0]?.ticket).toMatchObject({
      number: 40,
      kind: "pull_request",
      url: "https://github.test/acme/widgets/pull/40",
    });
  });
});

describe("the reviews that are asked for", () => {
  const opened = (number: number, runId = `run-${String(number)}`) => ({
    run: run(runId, { status: "succeeded", ticketRef: null }),
    step: prStep(runId, number),
  });

  // #924-T20
  it("lists an open pull request of a lane that a review is asked from the viewer for", async () => {
    const todos = service({
      prSteps: [opened(7)],
      items: [
        item(7, {
          kind: "pull_request",
          title: "Add widget caching",
          reviewRequestedFrom: ["Alice"],
          checksState: "success",
        }),
      ],
    });

    const list = await todos.list({ githubLogin: "alice" });

    expect(list.reviews).toEqual([
      expect.objectContaining({
        kind: "review",
        id: "review:r-1:7",
        projectId: "p-1",
        repositoryId: "r-1",
        repo: "acme/widgets",
        lane: "Implement",
        number: 7,
        title: "Add widget caching",
        url: "https://github.test/acme/widgets/pull/7",
        requestedFrom: ["Alice"],
        audience: "you",
        checksState: "success",
        since: T(3),
      }),
    ]);
  });

  // #924-T21
  it("shows a review that is asked from another member to every member, and one that is asked from nobody here to nobody", async () => {
    const todos = service({
      prSteps: [opened(7), opened(8)],
      items: [
        item(7, { kind: "pull_request", reviewRequestedFrom: ["bob"] }),
        item(8, { kind: "pull_request", reviewRequestedFrom: ["outsider"] }),
      ],
    });

    const alice = await todos.list({ githubLogin: "alice" });
    const stranger = await todos.list({ githubLogin: null });

    expect(alice.reviews.map((r) => [r.number, r.audience])).toEqual([
      [7, "members"],
    ]);
    expect(stranger.reviews.map((r) => r.number)).toEqual([7]);
  });

  // #924-T22
  it("is not a ToDo for a pull request no lane opened, one with no request, or one that is over", async () => {
    const todos = service({
      prSteps: [opened(7), opened(8)],
      items: [
        item(7, { kind: "pull_request", reviewRequestedFrom: [] }),
        item(8, {
          kind: "pull_request",
          reviewRequestedFrom: ["alice"],
          state: "closed",
        }),
        // opened by hand: no run of a lane opened it
        item(9, { kind: "pull_request", reviewRequestedFrom: ["alice"] }),
      ],
    });

    expect((await todos.list({ githubLogin: "alice" })).reviews).toEqual([]);
  });

  // #924-T23
  it("finds the review ToDo of a pull request for the action that checks it first", async () => {
    const todos = service({
      prSteps: [opened(7)],
      items: [
        item(7, { kind: "pull_request", reviewRequestedFrom: ["alice"] }),
      ],
    });

    expect(
      await todos.findReview({ githubLogin: "alice" }, "r-1", 7),
    ).toMatchObject({
      number: 7,
    });
    expect(
      await todos.findReview({ githubLogin: "alice" }, "r-1", 8),
    ).toBeUndefined();
    expect(
      await todos.findReview({ githubLogin: "alice" }, "r-2", 7),
    ).toBeUndefined();
  });
});

describe("the done list", () => {
  const answered = (runId: string, minute: number) => ({
    run: run(runId, { status: "running" }),
    step: step(runId, {
      status: "succeeded",
      ask: {
        n: 1,
        state: "resumed",
        question: `Question of ${runId}?`,
        options: ["yes", "no"],
        answer: {
          text: "yes",
          choice: 1,
          by: "alice",
          via: "ui",
          at: T(minute),
        },
      },
    }),
  });

  // #924-T30
  it("holds the last answered questions with their answer and the pull requests of a lane that ended with a review still asked, the newest first, at most 20", async () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      answered(`run-${String(index)}`, index),
    );
    const todos = service({
      answered: many,
      prSteps: [
        {
          run: run("run-pr", { status: "succeeded", ticketRef: null }),
          step: prStep("run-pr", 7),
        },
      ],
      items: [
        item(7, {
          kind: "pull_request",
          state: "closed",
          stateReason: "merged",
          reviewRequestedFrom: ["alice"],
          title: "Add widget caching",
          updatedAt: T(30),
        }),
      ],
    });

    const { done } = await todos.list({ githubLogin: "alice" });

    expect(done).toHaveLength(DONE_MAX);
    expect(done[0]).toMatchObject({
      kind: "review",
      number: 7,
      outcome: "merged",
      at: T(30),
    });
    expect(done[1]).toMatchObject({
      kind: "question",
      question: "Question of run-24?",
      answer: { text: "yes", choice: 1, by: "alice", via: "ui" },
      at: T(24),
    });
    expect(done.at(-1)).toMatchObject({ kind: "question", at: T(6) });
  });

  // #924-T31
  it("skips an ask whose answer cannot be read", async () => {
    const broken = answered("run-1", 1);
    const todos = service({
      answered: [{ ...broken, step: { ...broken.step, ask: "{not json" } }],
    });

    expect((await todos.list({ githubLogin: "alice" })).done).toEqual([]);
  });
});

describe("one project", () => {
  // #924-T40
  it("narrows the lists to the lanes and the repository of the project, and refuses a project the workspace does not have", async () => {
    const todos = service({
      waiting: [
        run("run-1"),
        run("run-2", { workflowId: "wf-2", repositoryId: "r-2" }),
      ],
      steps: { "run-1": [step("run-1")], "run-2": [step("run-2")] },
      lanes: {
        "wf-1": { name: "Implement", projectId: "p-1" },
        "wf-2": { name: "Fix", projectId: "p-2" },
      },
    });

    const all = await todos.list({ githubLogin: "alice" });
    const second = await todos.list(
      { githubLogin: "alice" },
      { projectId: "p-2" },
    );

    expect(all.questions.map((todo) => todo.runId).sort()).toEqual([
      "run-1",
      "run-2",
    ]);
    expect(second.projectId).toBe("p-2");
    expect(second.questions.map((todo) => todo.runId)).toEqual(["run-2"]);
    await expect(
      todos.list({ githubLogin: "alice" }, { projectId: "p-other" }),
    ).rejects.toMatchObject({ code: "TODOS_PROJECT_NOT_FOUND" });
    await expect(
      todos.list({ githubLogin: "alice" }, { projectId: "p-other" }),
    ).rejects.toBeInstanceOf(TodosError);
  });

  // #924-T41
  it("takes a lane without a project into the project of its repository", async () => {
    const todos = service({
      waiting: [run("run-1", { workflowId: "wf-old" })],
      steps: { "run-1": [step("run-1")] },
      lanes: { "wf-old": { name: "Old lane", projectId: null } },
    });

    const list = await todos.list(
      { githubLogin: "alice" },
      { projectId: "p-1" },
    );

    expect(list.questions[0]).toMatchObject({
      projectId: "p-1",
      lane: "Old lane",
    });
  });
});
