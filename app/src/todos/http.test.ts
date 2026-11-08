// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import { TodosError } from "./errors.ts";
import { createTodosRouteHandlers } from "./http.ts";
import type { ReviewActions } from "./review.ts";
import type { TodoList, TodosService } from "./service.ts";

const USER = { id: "u-1", githubLogin: "alice" } as SessionUser;
const LIST: TodoList = {
  projectId: null,
  questions: [],
  reviews: [],
  done: [],
};

function setup(
  service: Partial<TodosService> = {},
  reviews: Partial<ReviewActions> = {},
) {
  const requireUser = vi.fn(async () => USER);
  const fullService: TodosService = {
    list: vi.fn(async () => LIST),
    countOpen: vi.fn(async () => 0),
    findReview: vi.fn(async () => undefined),
    ...service,
  };
  const fullReviews: ReviewActions = {
    submit: vi.fn(async () => ({
      outcome: "submitted" as const,
      reviewId: "5001",
    })),
    ...reviews,
  };
  const handlers = createTodosRouteHandlers({
    requireUser,
    service: fullService,
    reviews: fullReviews,
  });
  return { handlers, requireUser, service: fullService, reviews: fullReviews };
}

const get = () => new Request("https://app.test/api/w/acme/todos");
const post = (
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
) =>
  new Request("https://app.test/api/w/acme/todos/reviews", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const VALID = { repositoryId: "r-1", number: 7, decision: "approve" };

describe("the lists", () => {
  // #924-T50
  it("answers the list of the workspace for the viewer by their GitHub login, never cached", async () => {
    const { handlers, service } = setup();

    const response = await handlers.list(get());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(LIST);
    expect(service.list).toHaveBeenCalledWith({ githubLogin: "alice" });
  });

  // #924-T51
  it("narrows the list to a project and answers its refusal with the code", async () => {
    const { handlers, service } = setup({
      list: vi.fn(async (_viewer, scope) => {
        if (scope?.projectId === "p-1") return { ...LIST, projectId: "p-1" };
        throw new TodosError("TODOS_PROJECT_NOT_FOUND", "No such project.");
      }),
    });

    const found = await handlers.listForProject(get(), "p-1");
    const missing = await handlers.listForProject(get(), "p-9");

    expect((await found.json()) as TodoList).toMatchObject({
      projectId: "p-1",
    });
    expect(service.list).toHaveBeenCalledWith(
      { githubLogin: "alice" },
      { projectId: "p-1" },
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: "TODOS_PROJECT_NOT_FOUND",
    });
  });

  // #924-T52
  it("reads nothing before the caller is known", async () => {
    const { handlers, service } = setup();
    const denied = createTodosRouteHandlers({
      requireUser: async () => {
        throw new Error("not signed in");
      },
      service: { ...service },
      reviews: { submit: vi.fn() },
    });

    await expect(denied.list(get())).rejects.toThrow("not signed in");
    expect(service.list).not.toHaveBeenCalled();
    void handlers;
  });
});

describe("a review", () => {
  // #924-T60
  it("hands a valid body to the action with the GitHub login of the person and answers its outcome", async () => {
    const { handlers, reviews } = setup();

    const response = await handlers.review(
      post({
        ...VALID,
        decision: "request_changes",
        comment: "Please add a test.",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "submitted",
      reviewId: "5001",
    });
    expect(reviews.submit).toHaveBeenCalledWith(
      { githubLogin: "alice" },
      {
        repositoryId: "r-1",
        number: 7,
        decision: "request_changes",
        comment: "Please add a test.",
      },
    );
  });

  // #924-T61
  it.each([
    ["a body that is no object", "[]", [""]],
    ["no fields", {}, ["repositoryId", "number", "decision"]],
    ["a decision that is none", { ...VALID, decision: "merge" }, ["decision"]],
    ["a number that is none", { ...VALID, number: 0 }, ["number"]],
    ["a field of its own", { ...VALID, extra: 1 }, ["extra"]],
    [
      "a comment that is too long",
      { ...VALID, comment: "x".repeat(4001) },
      ["comment"],
    ],
  ])(
    "names every problem of %s by path and code",
    async (_name, body, paths) => {
      const { handlers, reviews } = setup();

      const response = await handlers.review(post(body));
      const answer = (await response.json()) as {
        error: string;
        issues: {
          path: string;
          code: string;
          message: string;
          available?: string[];
        }[];
      };

      expect(response.status).toBe(400);
      expect(answer.error).toBe("TODOS_REQUEST_INVALID");
      expect(answer.issues.map((issue) => issue.path)).toEqual(paths);
      for (const issue of answer.issues) {
        expect(issue.code).toMatch(/^(required|invalid|too_long)$/);
        expect(issue.message).not.toBe("");
      }
      expect(reviews.submit).not.toHaveBeenCalled();
    },
  );

  // #924-T62
  it("names the decisions that would have been accepted", async () => {
    const { handlers } = setup();

    const answer = (await (
      await handlers.review(post({ ...VALID, decision: "merge" }))
    ).json()) as { issues: { available?: string[] }[] };

    expect(answer.issues[0]?.available).toEqual(["approve", "request_changes"]);
  });

  // #924-T63
  it("refuses a request from another site, a body that is not JSON, and one that is too large", async () => {
    const { handlers, reviews } = setup();

    const crossSite = await handlers.review(
      post(VALID, {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      }),
    );
    const wrongType = await handlers.review(
      post("x", { "content-type": "text/plain" }),
    );
    const notJson = await handlers.review(post("{nope"));
    const tooLarge = await handlers.review(
      post(JSON.stringify({ ...VALID, comment: "x".repeat(40_000) })),
    );

    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({
      error: "TODOS_CROSS_SITE_REQUEST",
    });
    expect(wrongType.status).toBe(415);
    expect(notJson.status).toBe(400);
    expect(tooLarge.status).toBe(413);
    expect(reviews.submit).not.toHaveBeenCalled();
  });

  // #924-T64
  it("answers the refusal of the action with its code and status", async () => {
    const { handlers } = setup(
      {},
      {
        submit: vi.fn(async () => {
          throw new TodosError(
            "TODOS_REVIEW_FAILED",
            "GitHub could not be asked.",
          );
        }),
      },
    );

    const response = await handlers.review(post(VALID));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "TODOS_REVIEW_FAILED",
      message: "GitHub could not be asked.",
    });
  });
});
