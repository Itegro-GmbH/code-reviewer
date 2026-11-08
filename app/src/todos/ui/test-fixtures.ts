// SPDX-License-Identifier: LicenseRef-Proprietary

// Fixtures of the ToDos UI tests (#925): a ToDo list as the route answers it, and a stand-in for the calls the page makes.
import { vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { ReviewOutcome } from "../review.ts";
import type {
  DoneTodo,
  QuestionTodo,
  ReviewTodo,
  TodoList,
} from "../service.ts";
import type { TodosApi } from "./api.ts";
import type { TodoActor } from "./actor.ts";

export const question = (over: Partial<QuestionTodo> = {}): QuestionTodo => ({
  kind: "question",
  id: "question:run-1:step-1:1",
  projectId: "p-1",
  repositoryId: "r-1",
  repo: "acme/widgets",
  runId: "run-1",
  workflowId: "wf-1",
  lane: "Implement",
  stepRunId: "step-1",
  stepId: "plan",
  n: 1,
  question: "Retry which failures?",
  context: null,
  options: ["Network errors", "Network errors and 5xx answers"],
  since: "2026-11-07T08:20:00.000Z",
  spentUsd: 0.75,
  budgetUsd: 5,
  ticket: {
    number: 12,
    kind: "issue",
    title: "Retry failed uploads",
    url: "https://github.com/acme/widgets/issues/12",
    labelled: true,
  },
  ...over,
});

export const review = (over: Partial<ReviewTodo> = {}): ReviewTodo => ({
  kind: "review",
  id: "review:r-1:7",
  projectId: "p-1",
  repositoryId: "r-1",
  repo: "acme/widgets",
  runId: "run-2",
  workflowId: "wf-1",
  lane: "Implement",
  number: 7,
  title: "Add widget caching",
  url: "https://github.com/acme/widgets/pull/7",
  requestedFrom: ["octocat"],
  audience: "you",
  checksState: "success",
  since: "2026-11-07T07:00:00.000Z",
  ...over,
});

export const doneQuestion = (over: Partial<DoneTodo> = {}): DoneTodo =>
  ({
    kind: "question",
    id: "question:run-9:step-9:1",
    projectId: "p-1",
    repositoryId: "r-1",
    repo: "acme/widgets",
    runId: "run-9",
    workflowId: "wf-1",
    lane: "Implement",
    n: 1,
    question: "Single or double opt-in?",
    options: [],
    answer: { text: "Double", by: "octocat", via: "ui" },
    ticket: null,
    at: "2026-11-06T10:00:00.000Z",
    ...over,
  }) as DoneTodo;

export const list = (over: Partial<TodoList> = {}): TodoList => ({
  projectId: null,
  questions: [question()],
  reviews: [review()],
  done: [doneQuestion()],
  ...over,
});

/** A member who may answer and review, with a GitHub login. */
export const ACTOR: TodoActor = { mayAct: true, hasLogin: true };

export const ok = <T>(data: T): RequestResult<T> => ({ ok: true, data });
export const failed = (
  code: string,
  status: number | null = 409,
): RequestResult<never> => ({ ok: false, status, code, issues: [] });

/** A stand-in for the calls: the lists it answers one after the other (the last one stays), and the answers to an answer or a review. */
export function fakeApi({
  lists = [list()],
  answer = ok({}),
  review: reviewResult = ok<ReviewOutcome>({
    outcome: "submitted",
    reviewId: "99",
  }),
}: {
  lists?: (TodoList | RequestResult<TodoList>)[];
  answer?: RequestResult<unknown>;
  review?: RequestResult<ReviewOutcome>;
} = {}) {
  let index = 0;
  const api = {
    list: vi.fn(async (): Promise<RequestResult<TodoList>> => {
      const next = lists[Math.min(index, lists.length - 1)];
      index += 1;
      if (next === undefined) return failed("UNEXPECTED_RESPONSE", 500);
      return "ok" in next ? next : ok(next);
    }),
    answer: vi.fn(async () => answer),
    review: vi.fn(async () => reviewResult),
  } satisfies TodosApi;
  return api;
}
