// SPDX-License-Identifier: LicenseRef-Proprietary

// #924: a review given from the list is a review of the App in the name of the person, on a pull request that is a ToDo of theirs only.
import { describe, expect, it, vi } from "vitest";
import { IntegrationError } from "../integrations/errors.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import { createReviewActions, type ReviewInput } from "./review.ts";
import type { ReviewTodo } from "./service.ts";

const REPO: RepoRef = {
  integrationId: "i-1",
  externalId: "ext-1",
  fullName: "acme/widgets",
  url: "https://github.test/acme/widgets",
};
const SHA = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";
const INPUT: ReviewInput = {
  repositoryId: "r-1",
  number: 7,
  decision: "approve",
  comment: "",
};
const TODO = { number: 7, repositoryId: "r-1" } as ReviewTodo;

function setup(
  options: {
    todo?: ReviewTodo | undefined;
    submit?: IntegrationProvider["submitReviewVerdict"];
    state?: "open" | "closed";
    target?: boolean;
  } = {},
) {
  const submit =
    options.submit ??
    vi.fn(async () => ({ outcome: "submitted" as const, reviewId: "5001" }));
  const commentOnIssue = vi.fn(async () => ({
    url: "https://github.test/acme/widgets/pull/7#issuecomment-1",
    existing: false,
  }));
  const getPullRequest = vi.fn(async () => ({
    number: 7,
    title: "Add widget caching",
    url: "https://github.test/acme/widgets/pull/7",
    headSha: SHA,
    baseRef: "main",
    headRef: "feature",
    draft: false,
    state: options.state ?? "open",
    author: { login: "app[bot]", externalId: "9" },
  }));
  const log = vi.fn();
  const actions = createReviewActions({
    todos: {
      findReview: vi.fn(async () => ("todo" in options ? options.todo : TODO)),
    },
    targetOf: async () =>
      options.target === false
        ? undefined
        : {
            provider: {
              submitReviewVerdict: submit,
              commentOnIssue,
              getPullRequest,
            } as unknown as IntegrationProvider,
            integration: { id: "i-1" } as Integration,
            repo: REPO,
          },
    log,
  });
  return { actions, submit, commentOnIssue, getPullRequest, log };
}

describe("a review from the list", () => {
  // #924-T70
  it("submits the review as the App on the commit that is the head now, with the attribution and the note", async () => {
    const { actions, submit } = setup();

    const outcome = await actions.submit(
      { githubLogin: "alice" },
      {
        ...INPUT,
        decision: "request_changes",
        comment: "Add a test for @team.",
      },
    );

    expect(outcome).toEqual({ outcome: "submitted", reviewId: "5001" });
    const [, repo, number, verdict, options] = (
      submit as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [
      unknown,
      RepoRef,
      number,
      Record<string, string>,
      unknown,
    ];
    expect(repo).toBe(REPO);
    expect(number).toBe(7);
    expect(verdict).toMatchObject({ headSha: SHA, event: "request_changes" });
    expect(verdict.body).toContain("Review by @alice: Changes requested");
    // a mention in the note is defused: the review does not ping anybody
    expect(verdict.body).toContain("Add a test for");
    expect(verdict.body).not.toContain("@team");
    expect(verdict.body.split("\n")[0]).toBe(verdict.marker);
    expect(verdict.marker).toContain(
      `pr=7 sha=${SHA} by=alice event=request_changes`,
    );
    expect(options).toEqual({ lookForEarlier: true });
  });

  // #924-T71
  it("never writes an email: a person without a GitHub login is a member of the workspace", async () => {
    const { actions, submit } = setup();

    await actions.submit({ githubLogin: null }, INPUT);

    const verdict = (submit as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as {
      body: string;
    };
    expect(verdict.body).toContain(
      "Review by a member of the workspace: Approved",
    );
  });

  // #924-T72
  it("says so when the same review is already there", async () => {
    const { actions } = setup({
      submit: vi.fn(async () => ({
        outcome: "already_there" as const,
        reviewId: "5000",
      })),
    });

    expect(await actions.submit({ githubLogin: "alice" }, INPUT)).toEqual({
      outcome: "already_there",
      reviewId: "5000",
    });
  });

  // #924-T73
  it("writes the decision as a comment of the App when GitHub refuses a review of the App's own pull request", async () => {
    const { actions, commentOnIssue } = setup({
      submit: vi.fn(async () => {
        throw new IntegrationError(
          "INTEGRATION_REQUEST_REFUSED",
          "Can not approve your own pull request",
        );
      }),
    });

    const outcome = await actions.submit({ githubLogin: "alice" }, INPUT);

    expect(outcome).toEqual({
      outcome: "commented",
      url: "https://github.test/acme/widgets/pull/7#issuecomment-1",
    });
    const call = (commentOnIssue as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      unknown,
      number,
      string,
      { marker: string },
    ];
    expect(call[2]).toBe(7);
    expect(call[3]).toContain("Review by @alice: Approved");
    expect(call[3]).toContain("does not let the App review");
    expect(call[4].marker).toContain(`sha=${SHA}`);
  });

  // #924-T74
  it("refuses a pull request that is no ToDo of the person, before GitHub is asked anything", async () => {
    const { actions, submit, getPullRequest } = setup({ todo: undefined });

    await expect(
      actions.submit({ githubLogin: "alice" }, INPUT),
    ).rejects.toMatchObject({ code: "TODOS_REVIEW_NOT_REQUESTED" });
    expect(getPullRequest).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  // #924-T75
  it("refuses a pull request that is not open any more, and a repository without a connection", async () => {
    const closed = setup({ state: "closed" });
    const gone = setup({ target: false });

    await expect(
      closed.actions.submit({ githubLogin: "alice" }, INPUT),
    ).rejects.toMatchObject({ code: "TODOS_REVIEW_NOT_REQUESTED" });
    await expect(
      gone.actions.submit({ githubLogin: "alice" }, INPUT),
    ).rejects.toMatchObject({ code: "TODOS_GITHUB_UNAVAILABLE" });
    expect(closed.submit).not.toHaveBeenCalled();
  });

  // #924-T76
  it("reports a failure of GitHub by its code only", async () => {
    const { actions, log } = setup({
      submit: vi.fn(async () => {
        throw new IntegrationError(
          "INTEGRATION_ACCESS_UNAVAILABLE",
          "token SECRET-VALUE rejected",
        );
      }),
    });

    const failure = await actions
      .submit({ githubLogin: "alice" }, INPUT)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "TODOS_REVIEW_FAILED" });
    expect((failure as Error).message).not.toContain("SECRET-VALUE");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("INTEGRATION_ACCESS_UNAVAILABLE"),
    );
    expect(String(log.mock.calls[0]?.[0])).not.toContain("SECRET-VALUE");
  });
});
