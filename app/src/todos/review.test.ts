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
const TODO = {
  number: 7,
  repositoryId: "r-1",
  requestedFrom: ["alice"],
  audience: "you",
} as ReviewTodo;
/** A review asked of the members by a fan-out: any member may answer. */
const FAN_OUT = {
  number: 7,
  repositoryId: "r-1",
  requestedFrom: ["alice", "bob"],
  audience: "members",
} as ReviewTodo;
const OWN_PULL_REQUEST = new IntegrationError(
  "INTEGRATION_REQUEST_REFUSED",
  "GitHub answered 422 for POST /repos/{owner}/{repo}/pulls/{n}/reviews.",
  { detail: "Can not approve your own pull request" },
);

function setup(
  options: {
    todo?: ReviewTodo | undefined;
    submit?: IntegrationProvider["submitReviewVerdict"];
    state?: "open" | "closed";
    target?: boolean;
    /** The reviewers GitHub says are asked now; `undefined`: the answer carries no list. */
    requested?: string[] | undefined;
    removeReviewers?: IntegrationProvider["removeReviewers"] | null;
    comment?: IntegrationProvider["commentOnIssue"];
  } = {},
) {
  const submit =
    options.submit ??
    vi.fn(async () => ({ outcome: "submitted" as const, reviewId: "5001" }));
  const commentOnIssue =
    options.comment ??
    vi.fn(async () => ({
      url: "https://github.test/acme/widgets/pull/7#issuecomment-1",
      existing: false,
    }));
  const removeReviewers =
    options.removeReviewers === undefined
      ? vi.fn(async () => ({ requested: [] as string[] }))
      : options.removeReviewers;
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
    ...("requested" in options
      ? options.requested === undefined
        ? {}
        : { requestedReviewers: options.requested }
      : { requestedReviewers: ["alice", "bob"] }),
  }));
  const tracker = {
    removeReviewRequested: vi.fn(async () => true),
    markReviewActed: vi.fn(async () => true),
  };
  const log = vi.fn();
  const actions = createReviewActions({
    todos: {
      findReview: vi.fn(async () => ("todo" in options ? options.todo : TODO)),
    },
    tracker,
    targetOf: async () =>
      options.target === false
        ? undefined
        : {
            provider: {
              submitReviewVerdict: submit,
              commentOnIssue,
              getPullRequest,
              ...(removeReviewers === null ? {} : { removeReviewers }),
            } as unknown as IntegrationProvider,
            integration: { id: "i-1" } as Integration,
            repo: REPO,
          },
    log,
  });
  return {
    actions,
    submit,
    commentOnIssue,
    getPullRequest,
    removeReviewers,
    tracker,
    log,
  };
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
    const { actions, submit } = setup({ todo: FAN_OUT });

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
        throw OWN_PULL_REQUEST;
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

describe("what a review leaves behind on the pull request", () => {
  const own = () =>
    vi.fn(async () => {
      throw OWN_PULL_REQUEST;
    });

  // #924-T77
  it("takes the caller's request away after the review, and the mirror row with it", async () => {
    const { actions, removeReviewers, tracker } = setup();

    await actions.submit({ githubLogin: "alice" }, INPUT);

    expect(removeReviewers).toHaveBeenCalledTimes(1);
    const call = (removeReviewers as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown[];
    expect(call[2]).toBe(7);
    expect(call[3]).toEqual(["alice"]);
    expect(tracker.removeReviewRequested).toHaveBeenCalledWith(
      "r-1",
      7,
      "alice",
    );
    expect(tracker.markReviewActed).not.toHaveBeenCalled();
  });

  // #924-T78
  it("does the same after the comment fallback, which is how a lane's own pull request is answered", async () => {
    const { actions, removeReviewers, tracker } = setup({ submit: own() });

    const outcome = await actions.submit({ githubLogin: "alice" }, INPUT);

    expect(outcome.outcome).toBe("commented");
    expect(removeReviewers).toHaveBeenCalledTimes(1);
    expect(tracker.removeReviewRequested).toHaveBeenCalledWith(
      "r-1",
      7,
      "alice",
    );
  });

  // #924-T79
  it("remembers the action in the mirror when the request cannot be taken away, so the ToDo does not stay as if nothing happened", async () => {
    const { actions, tracker, log } = setup({
      removeReviewers: vi.fn(async () => {
        throw new IntegrationError(
          "INTEGRATION_ACCESS_UNAVAILABLE",
          "token SECRET-VALUE rejected",
        );
      }),
    });

    expect(await actions.submit({ githubLogin: "alice" }, INPUT)).toEqual({
      outcome: "submitted",
      reviewId: "5001",
    });

    expect(tracker.markReviewActed).toHaveBeenCalledWith("r-1", 7, "alice");
    expect(tracker.removeReviewRequested).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("INTEGRATION_ACCESS_UNAVAILABLE"),
    );
    expect(String(log.mock.calls[0]?.[0])).not.toContain("SECRET-VALUE");
  });

  // #924-T80
  it("remembers the action too when the provider cannot take a request away, and when the caller was not asked by name", async () => {
    const noRemoval = setup({ removeReviewers: null });
    const notNamed = setup({ todo: FAN_OUT, requested: ["bob"] });

    await noRemoval.actions.submit({ githubLogin: "alice" }, INPUT);
    await notNamed.actions.submit({ githubLogin: "alice" }, INPUT);

    expect(noRemoval.tracker.markReviewActed).toHaveBeenCalledWith(
      "r-1",
      7,
      "alice",
    );
    // nothing to take away: alice has no request of her own, only the fan-out shows her the pull request
    expect(notNamed.removeReviewers).not.toHaveBeenCalled();
    expect(notNamed.tracker.markReviewActed).toHaveBeenCalledWith(
      "r-1",
      7,
      "alice",
    );
  });

  // #924-T81
  it("does not fail a posted review because the mirror could not be written", async () => {
    const { actions, tracker, log } = setup();
    tracker.removeReviewRequested.mockRejectedValue(new Error("db down"));

    expect(await actions.submit({ githubLogin: "alice" }, INPUT)).toEqual({
      outcome: "submitted",
      reviewId: "5001",
    });
    expect(log).toHaveBeenCalled();
  });

  // #924-T82
  it("leaves a person without a GitHub login alone: nothing of theirs to take away or to remember", async () => {
    const { actions, removeReviewers, tracker } = setup({ todo: FAN_OUT });

    await actions.submit({ githubLogin: null }, INPUT);

    expect(removeReviewers).not.toHaveBeenCalled();
    expect(tracker.markReviewActed).not.toHaveBeenCalled();
  });
});

describe("what is checked live before a review is given", () => {
  // #924-T83
  it("refuses a review whose request GitHub no longer holds, also for an open pull request", async () => {
    const taken = setup({ requested: ["bob"] });
    const none = setup({ requested: [] });

    await expect(
      taken.actions.submit({ githubLogin: "alice" }, INPUT),
    ).rejects.toMatchObject({ code: "TODOS_REVIEW_NOT_REQUESTED" });
    await expect(
      none.actions.submit({ githubLogin: "alice" }, INPUT),
    ).rejects.toMatchObject({ code: "TODOS_REVIEW_NOT_REQUESTED" });
    expect(taken.submit).not.toHaveBeenCalled();
  });

  // #924-T84
  it("lets any member answer a fan-out as long as one of the asked members is still asked, and trusts a mirror when GitHub sends no list", async () => {
    const stillAsked = setup({ todo: FAN_OUT, requested: ["bob"] });
    const unknown = setup({ requested: undefined });

    await stillAsked.actions.submit({ githubLogin: "carol" }, INPUT);
    await unknown.actions.submit({ githubLogin: "alice" }, INPUT);

    expect(stillAsked.submit).toHaveBeenCalledTimes(1);
    expect(unknown.submit).toHaveBeenCalledTimes(1);
  });
});

describe("which refusal of GitHub is the App's own pull request", () => {
  // #924-T85
  it.each([
    ["Can not approve your own pull request"],
    ["Can not request changes on your own pull request"],
  ])("takes %s for the case of the comment fallback", async (detail) => {
    const { actions } = setup({
      submit: vi.fn(async () => {
        throw new IntegrationError("INTEGRATION_REQUEST_REFUSED", "refused", {
          detail,
        });
      }),
    });

    expect(
      (await actions.submit({ githubLogin: "alice" }, INPUT)).outcome,
    ).toBe("commented");
  });

  // #924-T86
  it("fails any other 422 with its code logged and no text of GitHub, and writes no comment", async () => {
    const { actions, commentOnIssue, log } = setup({
      submit: vi.fn(async () => {
        throw new IntegrationError("INTEGRATION_REQUEST_REFUSED", "refused", {
          detail: "Unprocessable: commit_id SECRET-VALUE is not part of it",
        });
      }),
    });
    const withoutText = setup({
      submit: vi.fn(async () => {
        throw new IntegrationError("INTEGRATION_REQUEST_REFUSED", "refused");
      }),
    });

    await expect(
      actions.submit({ githubLogin: "alice" }, INPUT),
    ).rejects.toMatchObject({ code: "TODOS_REVIEW_FAILED" });
    await expect(
      withoutText.actions.submit({ githubLogin: "alice" }, INPUT),
    ).rejects.toMatchObject({ code: "TODOS_REVIEW_FAILED" });

    expect(commentOnIssue).not.toHaveBeenCalled();
    expect(withoutText.commentOnIssue).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("INTEGRATION_REQUEST_REFUSED"),
    );
    expect(String(log.mock.calls[0]?.[0])).not.toContain("SECRET-VALUE");
  });
});
