// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import { ManualReviewError } from "../../../manual-reviews/errors.ts";
import { TodosError } from "../../../todos/errors.ts";
import { TrackerError } from "../../../tracker/errors.ts";
import { WorkflowRunError } from "../../../workflow-runs/errors.ts";
import { workflowRunsService } from "../runs/services.ts";
import {
  LANE_ID,
  RUN_ID,
  contextWith,
  data,
  failure,
  run,
} from "../runs/test-support.ts";
import {
  manualReviewService,
  projectService,
  reviewActions,
  reviewRunsService,
  todosService,
  trackerService,
} from "./services.ts";

const PROJECT = {
  id: "proj-1",
  repositoryId: "repo-code",
  ticketSource: {
    provider: "github",
    repositoryId: "repo-tickets",
    board: null,
  },
};

const QUESTION = {
  kind: "question",
  id: "question:run-1:step-1:2",
  runId: RUN_ID,
  workflowId: LANE_ID,
  stepRunId: "step-1",
  n: 2,
  question: "Which database?",
  options: ["Postgres", "SQLite"],
};
const REVIEW = {
  kind: "review",
  id: "review:repo-code:7",
  repositoryId: "repo-code",
  number: 7,
  title: "Add x",
};
const TODO_LIST = {
  projectId: null,
  questions: [QUESTION],
  reviews: [REVIEW],
  done: [],
};

type Fakes = Partial<{
  todos: Record<string, unknown>;
  reviews: Record<string, unknown>;
  tracker: Record<string, unknown>;
  projects: Record<string, unknown>;
  manual: Record<string, unknown>;
  runs: Record<string, unknown>;
  reviewRuns: Record<string, unknown>;
}>;

function setup(
  fakes: Fakes = {},
  overrides: Parameters<typeof contextWith>[1] = {},
) {
  return contextWith(
    [
      [todosService as never, fakes.todos ?? { list: async () => TODO_LIST }],
      [reviewActions as never, fakes.reviews ?? {}],
      [trackerService as never, fakes.tracker ?? {}],
      [
        projectService as never,
        fakes.projects ?? { getProject: async () => PROJECT },
      ],
      [manualReviewService as never, fakes.manual ?? {}],
      [workflowRunsService as never, fakes.runs ?? {}],
      [reviewRunsService as never, fakes.reviewRuns ?? {}],
    ],
    overrides,
  );
}

describe("list_todos", () => {
  // #1146-T70
  it("lists the questions, reviews and done ToDos of the workspace for a person without a GitHub login", async () => {
    const list = vi.fn(async () => TODO_LIST);
    const answer = await data("list_todos", setup({ todos: { list } }), {});
    expect(list).toHaveBeenCalledWith({ githubLogin: null }, undefined);
    expect(answer).toMatchObject({
      questions: [{ id: QUESTION.id }],
      reviews: [{ id: REVIEW.id }],
      done: [],
    });
  });

  // #1146-T71
  it("narrows to one project, and maps a project the workspace does not have", async () => {
    const list = vi.fn(async () => {
      throw new TodosError("TODOS_PROJECT_NOT_FOUND", "no project");
    });
    const context = setup({ todos: { list } });
    expect(
      await failure("list_todos", context, { projectId: "nope" }),
    ).toMatchObject({
      error: "not_found",
      code: "TODOS_PROJECT_NOT_FOUND",
    });
    expect(list).toHaveBeenCalledWith(
      { githubLogin: null },
      { projectId: "nope" },
    );
  });

  // #1146-T72
  it("is allowed with the read scope for every member", async () => {
    expect(
      await data(
        "list_todos",
        setup({}, { scopes: ["factory:read"], role: "member" }),
        {},
      ),
    ).toMatchObject({ questions: expect.any(Array) });
  });
});

describe("resolve_todo", () => {
  // #1146-T80
  it("answers a question through the run service of the question's lane, with no GitHub login", async () => {
    const answer = vi.fn(async () => ({ run: run() }));
    const answered = await data("resolve_todo", setup({ runs: { answer } }), {
      id: QUESTION.id,
      choice: 1,
      text: "ok",
    });
    expect(answer).toHaveBeenCalledWith(
      { id: "user-ada", githubLogin: null },
      LANE_ID,
      RUN_ID,
      { question: { stepRunId: "step-1", n: 2 }, choice: 1, text: "ok" },
    );
    expect(answered).toMatchObject({
      kind: "question",
      id: QUESTION.id,
      run: { id: RUN_ID },
    });
  });

  // #1146-T81
  it("reviews a pull request through the review actions", async () => {
    const submit = vi.fn(async () => ({
      outcome: "submitted",
      reviewId: "99",
    }));
    const answered = await data(
      "resolve_todo",
      setup({ reviews: { submit } }),
      {
        id: REVIEW.id,
        decision: "request_changes",
        comment: "tests missing",
      },
    );
    expect(submit).toHaveBeenCalledWith(
      { githubLogin: null },
      {
        repositoryId: "repo-code",
        number: 7,
        decision: "request_changes",
        comment: "tests missing",
      },
    );
    expect(answered).toMatchObject({
      kind: "review",
      outcome: "submitted",
      reviewId: "99",
    });
  });

  // #1146-T82
  it("asks for what the kind of ToDo needs, and refuses what it does not take", async () => {
    const answer = vi.fn();
    const submit = vi.fn();
    const context = setup({ runs: { answer }, reviews: { submit } });
    expect(
      await failure("resolve_todo", context, { id: QUESTION.id }),
    ).toMatchObject({
      error: "invalid_input",
      options: ["Postgres", "SQLite"],
    });
    expect(
      await failure("resolve_todo", context, {
        id: QUESTION.id,
        text: "x",
        decision: "approve",
      }),
    ).toMatchObject({ error: "invalid_input" });
    expect(
      await failure("resolve_todo", context, { id: REVIEW.id }),
    ).toMatchObject({
      error: "invalid_input",
    });
    expect(
      await failure("resolve_todo", context, {
        id: REVIEW.id,
        decision: "approve",
        text: "x",
      }),
    ).toMatchObject({ error: "invalid_input" });
    expect(answer).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  // #1146-T83
  it("is not_found for a ToDo that is not open", async () => {
    expect(
      await failure("resolve_todo", setup(), {
        id: "question:gone:x:1",
        text: "x",
      }),
    ).toMatchObject({ error: "not_found" });
  });

  // #1146-T84
  it("maps the refusals of the run service and of the review action", async () => {
    const stale = setup({
      runs: {
        answer: async () => {
          throw new WorkflowRunError(
            "WORKFLOW_RUN_QUESTION_CHANGED",
            "changed",
          );
        },
      },
    });
    expect(
      await failure("resolve_todo", stale, { id: QUESTION.id, text: "x" }),
    ).toMatchObject({
      error: "conflict",
      code: "WORKFLOW_RUN_QUESTION_CHANGED",
    });
    const unavailable = setup({
      reviews: {
        submit: async () => {
          throw new TodosError("TODOS_REVIEW_FAILED", "GitHub failed");
        },
      },
    });
    expect(
      await failure("resolve_todo", unavailable, {
        id: REVIEW.id,
        decision: "approve",
      }),
    ).toMatchObject({ error: "unavailable", code: "TODOS_REVIEW_FAILED" });
    const notAsked = setup({
      reviews: {
        submit: async () => {
          throw new TodosError("TODOS_REVIEW_NOT_REQUESTED", "not asked");
        },
      },
    });
    expect(
      await failure("resolve_todo", notAsked, {
        id: REVIEW.id,
        decision: "approve",
      }),
    ).toMatchObject({ error: "not_found" });
  });

  // #1146-T85
  it("needs the control scope", async () => {
    expect(
      await failure("resolve_todo", setup({}, { scopes: ["factory:read"] }), {
        id: QUESTION.id,
        text: "x",
      }),
    ).toMatchObject({ error: "insufficient_scope" });
  });
});

describe("list_issues and sync_issues", () => {
  // #1146-T90
  it("lists the tickets of the project's ticket source with the query the route takes", async () => {
    const listIssuesFake = vi.fn(async () => ({
      issues: [{ number: 3 }],
      total: 1,
    }));
    const answer = await data(
      "list_issues",
      setup({ tracker: { listIssues: listIssuesFake } }),
      { projectId: "proj-1", state: "all", limit: 5, offset: 10 },
    );
    expect(listIssuesFake).toHaveBeenCalledWith("repo-tickets", {
      state: "all",
      limit: 5,
      offset: 10,
    });
    expect(answer).toMatchObject({ issues: [{ number: 3 }] });
  });

  // #1146-T91
  it("defaults to the open tickets, first page", async () => {
    const listIssuesFake = vi.fn(async () => ({ issues: [] }));
    await data(
      "list_issues",
      setup({ tracker: { listIssues: listIssuesFake } }),
      {
        projectId: "proj-1",
      },
    );
    expect(listIssuesFake).toHaveBeenCalledWith("repo-tickets", {
      state: "open",
      limit: 100,
      offset: 0,
    });
  });

  // #1146-T92
  it("is not_found for a project the workspace does not have, and refuses a state that is none", async () => {
    const context = setup({ projects: { getProject: async () => undefined } });
    expect(
      await failure("list_issues", context, { projectId: "x" }),
    ).toMatchObject({
      error: "not_found",
    });
    expect(
      await failure("list_issues", setup(), {
        projectId: "proj-1",
        state: "bogus",
      }),
    ).toMatchObject({ error: "invalid_input" });
  });

  // #1146-T93
  it.each([
    ["TRACKER_PROJECT_NOT_ACTIVE", "conflict"],
    ["TRACKER_SOURCE_NOT_MIRRORED", "conflict"],
    ["TRACKER_INTEGRATION_UNAVAILABLE", "unavailable"],
    ["TRACKER_REPOSITORY_NOT_FOUND", "not_found"],
  ] as const)("maps %s to %s", async (serviceCode, code) => {
    const context = setup({
      tracker: {
        listIssues: async () => {
          throw new TrackerError(serviceCode, "no");
        },
      },
    });
    expect(
      await failure("list_issues", context, { projectId: "proj-1" }),
    ).toMatchObject({
      error: code,
      code: serviceCode,
    });
  });

  // #1146-T94
  it("syncs with the route's twenty second budget and says whether the mirror is complete", async () => {
    const sync = vi.fn(async () => ({ status: "done", synced: 12 }));
    const done = await data("sync_issues", setup({ tracker: { sync } }), {
      projectId: "proj-1",
    });
    expect(sync).toHaveBeenCalledWith("repo-tickets", {
      deadline: new Date("2026-11-25T10:00:00.000Z").getTime() + 20_000,
    });
    expect(done).toMatchObject({ complete: true, status: "done" });
    const more = await data(
      "sync_issues",
      setup({ tracker: { sync: async () => ({ status: "partial" }) } }),
      { projectId: "proj-1" },
    );
    expect(more).toMatchObject({ complete: false });
  });

  // #1146-T95
  it("needs the control scope to sync, maps a failed sync, and a read token may still list", async () => {
    expect(
      await failure("sync_issues", setup({}, { scopes: ["factory:read"] }), {
        projectId: "proj-1",
      }),
    ).toMatchObject({ error: "insufficient_scope" });
    const failed = setup({
      tracker: {
        sync: async () => {
          throw new TrackerError("TRACKER_SYNC_FAILED", "GitHub failed");
        },
      },
    });
    expect(
      await failure("sync_issues", failed, { projectId: "proj-1" }),
    ).toMatchObject({
      error: "unavailable",
      code: "TRACKER_SYNC_FAILED",
    });
    expect(
      await data(
        "list_issues",
        setup(
          { tracker: { listIssues: async () => ({ issues: [] }) } },
          { scopes: ["factory:read"] },
        ),
        { projectId: "proj-1" },
      ),
    ).toMatchObject({ issues: [] });
  });
});

describe("list_pull_requests and list_reviews", () => {
  // #1146-T100
  it("lists the open pull requests of the project's repository", async () => {
    const listOpenPullRequests = vi.fn(async () => ({
      repositoryId: "repo-code",
      pullRequests: [{ number: 7, title: "Add x" }],
      allowedCommands: ["review"],
    }));
    const answer = await data(
      "list_pull_requests",
      setup({ manual: { listOpenPullRequests } }),
      { projectId: "proj-1" },
    );
    expect(listOpenPullRequests).toHaveBeenCalledWith("repo-code");
    expect(answer).toMatchObject({ pullRequests: [{ number: 7 }] });
  });

  // #1146-T101
  it("maps the failures of GitHub and of an uninstalled app, and a project that is not there", async () => {
    const make = (code: ConstructorParameters<typeof ManualReviewError>[0]) =>
      setup({
        manual: {
          listOpenPullRequests: async () => {
            throw new ManualReviewError(code, "no");
          },
        },
      });
    expect(
      await failure(
        "list_pull_requests",
        make("MANUAL_REVIEW_GITHUB_UNAVAILABLE"),
        { projectId: "proj-1" },
      ),
    ).toMatchObject({ error: "unavailable" });
    expect(
      await failure(
        "list_pull_requests",
        make("MANUAL_REVIEW_APP_NOT_INSTALLED"),
        { projectId: "proj-1" },
      ),
    ).toMatchObject({ error: "unavailable" });
    expect(
      await failure(
        "list_pull_requests",
        make("MANUAL_REVIEW_PROJECT_NOT_FOUND"),
        { projectId: "proj-1" },
      ),
    ).toMatchObject({ error: "not_found" });
    expect(
      await failure(
        "list_pull_requests",
        setup({ projects: { getProject: async () => undefined } }),
        {
          projectId: "x",
        },
      ),
    ).toMatchObject({ error: "not_found" });
  });

  // #1146-T102
  it("lists the reviews of the review product, narrowed to a project and a status", async () => {
    const list = vi.fn(async () => ({
      generatedAt: "now",
      runs: [{ id: "j1" }],
      limited: false,
    }));
    const answer = await data("list_reviews", setup({ reviewRuns: { list } }), {
      projectId: "proj-1",
      status: "failed",
    });
    expect(list).toHaveBeenCalledWith({
      repositoryId: "repo-code",
      status: "failed",
    });
    expect(answer).toMatchObject({ runs: [{ id: "j1" }], limited: false });
    await data("list_reviews", setup({ reviewRuns: { list } }), {});
    expect(list).toHaveBeenLastCalledWith({});
  });

  // #1146-T103
  it("refuses a status the review product does not have, and a project that is not there", async () => {
    expect(
      await failure("list_reviews", setup(), { status: "waiting" }),
    ).toMatchObject({
      error: "invalid_input",
    });
    expect(
      await failure(
        "list_reviews",
        setup({ projects: { getProject: async () => undefined } }),
        {
          projectId: "x",
        },
      ),
    ).toMatchObject({ error: "not_found" });
  });
});
