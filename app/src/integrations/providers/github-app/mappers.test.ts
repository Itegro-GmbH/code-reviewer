// SPDX-License-Identifier: LicenseRef-Proprietary

// #924: a pull request of GitHub says who a review is asked from now (`requested_reviewers`), which the ToDo list checks before a review
// is given; an answer that carries no such list says nothing about it.
import { describe, expect, it } from "vitest";
import { toPullRequestRef } from "./mappers.ts";

const pull = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: "A pull request",
  html_url: "https://github.com/acme/widgets/pull/7",
  state: "open",
  user: { login: "app[bot]", id: 9 },
  head: { sha: "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01", ref: "feature" },
  base: { ref: "main" },
  ...over,
});

describe("the pull request of GitHub", () => {
  // #924-T11
  it("carries the logins a review is asked from, once each, and none when the answer has no list", () => {
    expect(
      toPullRequestRef(
        pull({
          requested_reviewers: [{ login: "alice" }, { login: "alice" }, {}],
        }),
      )?.requestedReviewers,
    ).toEqual(["alice"]);
    expect(
      toPullRequestRef(pull({ requested_reviewers: [] }))?.requestedReviewers,
    ).toEqual([]);
    expect(toPullRequestRef(pull())).not.toHaveProperty("requestedReviewers");
  });
});
