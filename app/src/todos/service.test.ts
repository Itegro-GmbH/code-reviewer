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
    discardedAt: null,
    pauseRequestedAt: null,
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
    reviewActedBy: [],
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
  /** The lanes whose document asks `reviewers: "project members"`; the others name their reviewers. */
  fanOut?: string[];
};

/** What the service asked the runs repository, to prove how often and with which narrowing. */
type Asked = {
  waiting: (readonly string[] | undefined)[];
  steps: (readonly string[])[];
  answered: (readonly string[] | undefined)[];
  pullRequests: (readonly string[] | undefined)[];
};

function service(world: World = {}, asked?: Asked) {
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
      async getVersion(id, version) {
        const document = world.fanOut?.includes(id)
          ? {
              steps: [
                {
                  action: "ticket.requestReview",
                  inputs: { reviewers: "project members" },
                },
              ],
            }
          : {
              steps: [
                {
                  action: "ticket.requestReview",
                  inputs: { reviewers: ["bob"] },
                },
              ],
            };
        return {
          workflowId: id,
          version,
          document: JSON.stringify(document),
          createdBy: "u-1",
          createdAt: T(0),
        };
      },
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
      async listWaiting(_limit, repositoryIds) {
        asked?.waiting.push(repositoryIds);
        return (world.waiting ?? []).filter(
          (candidate) =>
            repositoryIds === undefined ||
            repositoryIds.includes(candidate.repositoryId),
        );
      },
      async listStepsOfRuns(runIds) {
        asked?.steps.push(runIds);
        return new Map(
          runIds.map((runId) => [runId, world.steps?.[runId] ?? []]),
        );
      },
      async listAnsweredAskSteps(_limit, repositoryIds) {
        asked?.answered.push(repositoryIds);
        return (world.answered ?? []).filter(
          ({ run: candidate }) =>
            repositoryIds === undefined ||
            repositoryIds.includes(candidate.repositoryId),
        );
      },
      async listPullRequestSteps(_limit, repositoryIds) {
        asked?.pullRequests.push(repositoryIds);
        return (world.prSteps ?? []).filter(
          ({ run: candidate }) =>
            repositoryIds === undefined ||
            repositoryIds.includes(candidate.repositoryId),
        );
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
  it("shows a review that is asked from another member to every member only when the lane asked `project members`, and one asked from nobody here to nobody", async () => {
    const todos = service({
      fanOut: ["wf-fan"],
      lanes: {
        "wf-1": { name: "Implement", projectId: "p-1" },
        "wf-fan": { name: "Fan out", projectId: "p-1" },
      },
      prSteps: [
        opened(7),
        {
          run: run("run-8", {
            status: "succeeded",
            ticketRef: null,
            workflowId: "wf-fan",
          }),
          step: prStep("run-8", 8),
        },
        {
          run: run("run-9", {
            status: "succeeded",
            ticketRef: null,
            workflowId: "wf-fan",
          }),
          step: prStep("run-9", 9),
        },
      ],
      items: [
        // asked by name: only bob can act on it
        item(7, { kind: "pull_request", reviewRequestedFrom: ["bob"] }),
        // the fan-out of the lane: any member can
        item(8, { kind: "pull_request", reviewRequestedFrom: ["bob", "dave"] }),
        item(9, { kind: "pull_request", reviewRequestedFrom: ["outsider"] }),
      ],
    });

    const alice = await todos.list({ githubLogin: "alice" });
    const bob = await todos.list({ githubLogin: "bob" });
    const stranger = await todos.list({ githubLogin: null });

    expect(alice.reviews.map((r) => [r.number, r.audience])).toEqual([
      [8, "members"],
    ]);
    expect(bob.reviews.map((r) => [r.number, r.audience]).sort()).toEqual([
      [7, "you"],
      [8, "you"],
    ]);
    expect(stranger.reviews.map((r) => r.number)).toEqual([8]);
  });

  // #924-T24
  it("lets only the logins that are named act on a request that names logins: carol cannot act on a pull request asked of bob", async () => {
    const todos = service({
      members: ["alice", "bob", "carol"],
      prSteps: [opened(7)],
      items: [item(7, { kind: "pull_request", reviewRequestedFrom: ["bob"] })],
    });

    expect(
      await todos.findReview({ githubLogin: "carol" }, "r-1", 7),
    ).toBeUndefined();
    expect(
      await todos.findReview({ githubLogin: null }, "r-1", 7),
    ).toBeUndefined();
    expect(
      await todos.findReview({ githubLogin: "Bob" }, "r-1", 7),
    ).toMatchObject({ number: 7, audience: "you" });
  });

  // #924-T25
  it("lets any member find the fan-out of a lane that asked `project members`", async () => {
    const todos = service({
      members: ["alice", "bob", "carol"],
      fanOut: ["wf-1"],
      prSteps: [opened(7)],
      items: [item(7, { kind: "pull_request", reviewRequestedFrom: ["bob"] })],
    });

    expect(
      await todos.findReview({ githubLogin: "carol" }, "r-1", 7),
    ).toMatchObject({ number: 7, audience: "members" });
  });

  // #924-T26
  it("hides a review from the login that acted on it while GitHub still holds the request, and keeps it for the others", async () => {
    const todos = service({
      members: ["alice", "bob", "carol"],
      fanOut: ["wf-1"],
      prSteps: [opened(7)],
      items: [
        item(7, {
          kind: "pull_request",
          reviewRequestedFrom: ["alice", "bob"],
          reviewActedBy: [{ login: "Alice", sha: "head-1" }],
        }),
      ],
    });

    expect((await todos.list({ githubLogin: "alice" })).reviews).toEqual([]);
    expect(
      await todos.findReview({ githubLogin: "alice" }, "r-1", 7),
    ).toBeUndefined();
    expect(
      (await todos.list({ githubLogin: "bob" })).reviews.map((r) => r.number),
    ).toEqual([7]);
    expect(
      (await todos.list({ githubLogin: "carol" })).reviews.map((r) => r.number),
    ).toEqual([7]);
  });

  // #924-T26b
  it("keeps a review hidden from a member of the fan-out who acted although GitHub never asked them by name", async () => {
    const todos = service({
      members: ["alice", "bob", "carol"],
      fanOut: ["wf-1"],
      prSteps: [opened(7)],
      items: [
        item(7, {
          kind: "pull_request",
          reviewRequestedFrom: ["alice"],
          reviewActedBy: [{ login: "carol", sha: "head-1" }],
        }),
      ],
    });

    expect((await todos.list({ githubLogin: "carol" })).reviews).toEqual([]);
    expect(
      (await todos.list({ githubLogin: "bob" })).reviews.map((r) => r.number),
    ).toEqual([7]);
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

  // #925: the number on the sidebar's ToDos link
  it("counts the open questions and the reviews of the viewer for the badge, and nothing of the done list", async () => {
    const todos = service({
      waiting: [run("run-1")],
      steps: { "run-1": [step("run-1")] },
      prSteps: [opened(7), opened(8)],
      items: [
        item(7, { kind: "pull_request", reviewRequestedFrom: ["alice"] }),
        item(8, { kind: "pull_request", reviewRequestedFrom: ["bob"] }),
      ],
    });

    expect(await todos.countOpen({ githubLogin: "alice" })).toBe(2);
    expect(await todos.countOpen({ githubLogin: "bob" })).toBe(2);
    expect(await todos.countOpen({ githubLogin: "carol" })).toBe(1);
    expect(await todos.countOpen({ githubLogin: null })).toBe(1);
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

  // #924-T32
  it("applies the audience of the reviews to the pull requests that are over: a request by name is done by that person only", async () => {
    const closed = (number: number, workflowId: string) => ({
      run: run(`run-${String(number)}`, {
        status: "succeeded",
        ticketRef: null,
        workflowId,
      }),
      step: prStep(`run-${String(number)}`, number),
    });
    const todos = service({
      members: ["alice", "bob", "carol"],
      fanOut: ["wf-fan"],
      lanes: {
        "wf-1": { name: "Implement", projectId: "p-1" },
        "wf-fan": { name: "Fan out", projectId: "p-1" },
      },
      prSteps: [closed(7, "wf-1"), closed(8, "wf-fan"), closed(9, "wf-1")],
      items: [
        item(7, {
          kind: "pull_request",
          state: "closed",
          reviewRequestedFrom: ["bob"],
        }),
        item(8, {
          kind: "pull_request",
          state: "closed",
          reviewRequestedFrom: ["bob"],
        }),
        item(9, {
          kind: "pull_request",
          state: "closed",
          reviewRequestedFrom: ["outsider"],
        }),
      ],
    });

    const numbers = async (githubLogin: string | null) =>
      (await todos.list({ githubLogin })).done
        .map((entry) => (entry.kind === "review" ? entry.number : -1))
        .sort();

    expect(await numbers("bob")).toEqual([7, 8]);
    expect(await numbers("carol")).toEqual([8]);
    expect(await numbers(null)).toEqual([8]);
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

describe("the queries behind the lists", () => {
  const nothing = (): Asked => ({
    waiting: [],
    steps: [],
    answered: [],
    pullRequests: [],
  });

  // #924-T50
  it("reads the steps of all waiting runs in one query, not one per run", async () => {
    const asked = nothing();
    const todos = service(
      {
        waiting: [run("run-1"), run("run-2"), run("run-3")],
        steps: {
          "run-1": [step("run-1")],
          "run-2": [step("run-2")],
          "run-3": [step("run-3")],
        },
      },
      asked,
    );

    const list = await todos.list({ githubLogin: "alice" });

    expect(list.questions).toHaveLength(3);
    // one for the questions; the answered questions and the pull requests of lanes that are none add none
    expect(asked.steps).toEqual([["run-1", "run-2", "run-3"]]);
  });

  // #924-T51
  it("reads the places of the answered questions with one query too", async () => {
    const asked = nothing();
    const answeredStep = (runId: string, minute: number) => ({
      run: run(runId, { status: "running" }),
      step: step(runId, {
        status: "succeeded",
        ask: {
          n: 1,
          state: "resumed",
          question: "q?",
          answer: { text: "a", by: "alice", via: "ui", at: T(minute) },
        },
      }),
    });
    const todos = service(
      { answered: [answeredStep("run-1", 1), answeredStep("run-2", 2)] },
      asked,
    );

    await todos.list({ githubLogin: "alice" });

    expect(asked.steps).toEqual([["run-2", "run-1"]]);
  });

  // #924-T52
  it("narrows the queries to the repository of the project, so the rows of another project cannot push its ToDos past the cap", async () => {
    const asked = nothing();
    const todos = service(
      {
        waiting: [
          run("run-1"),
          run("run-2", { workflowId: "wf-2", repositoryId: "r-2" }),
        ],
        steps: { "run-1": [step("run-1")], "run-2": [step("run-2")] },
        lanes: {
          "wf-1": { name: "Implement", projectId: "p-1" },
          "wf-2": { name: "Fix", projectId: "p-2" },
        },
      },
      asked,
    );

    const second = await todos.list(
      { githubLogin: "alice" },
      { projectId: "p-2" },
    );

    expect(second.questions.map((todo) => todo.runId)).toEqual(["run-2"]);
    expect(asked.waiting).toEqual([["r-2"]]);
    expect(asked.answered).toEqual([["r-2"]]);
    expect(asked.pullRequests).toEqual([["r-2"]]);
    // the steps are read for the runs that were found, which are the project's only
    expect(asked.steps).toEqual([["run-2"]]);
  });

  // #924-T53
  it("does not narrow the lists of the whole workspace, and looks only at the repository of a review that is acted on", async () => {
    const asked = nothing();
    const todos = service(
      {
        prSteps: [
          {
            run: run("run-1", { status: "succeeded", ticketRef: null }),
            step: prStep("run-1", 7),
          },
        ],
        items: [
          item(7, { kind: "pull_request", reviewRequestedFrom: ["alice"] }),
        ],
      },
      asked,
    );

    await todos.list({ githubLogin: "alice" });
    await todos.findReview({ githubLogin: "alice" }, "r-1", 7);

    expect(asked.waiting).toEqual([undefined]);
    expect(asked.pullRequests).toEqual([undefined, ["r-1"]]);
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
