// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The review panel (#925): the pull request with its link, approve and request changes with an optional note, the three outcomes of the
// route (`submitted`, `commented`, `already_there`), its errors, and one decision at a time.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewForm } from "./review-panel.tsx";
import { failed, fakeApi, ok, review } from "./test-fixtures.ts";
import type { ReviewOutcome } from "../review.ts";

afterEach(cleanup);

function setup(
  over: Parameters<typeof review>[0] = {},
  api = fakeApi(),
  open = true,
) {
  const onChanged = vi.fn();
  render(
    <ReviewForm
      todo={review(over)}
      open={open}
      api={api}
      onChanged={onChanged}
    />,
  );
  return { api, onChanged, user: userEvent.setup() };
}

describe("the review panel", () => {
  // #925
  it("shows the pull request with a link to it on GitHub, who is asked and the checks", () => {
    setup();

    expect(
      screen
        .getByRole("link", { name: "Open the pull request on GitHub" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/pull/7");
    expect(screen.getByText(/Add widget caching/)).toBeTruthy();
    expect(screen.getByText("success")).toBeTruthy();
    expect(screen.getByText("Asked of you")).toBeTruthy();
  });

  // #925
  it("says a fan-out review is asked of the project members", () => {
    setup({ audience: "members" });

    expect(screen.getByText(/Asked of the project members/)).toBeTruthy();
  });

  // #925
  it("makes no link of an address that is not a web address", () => {
    setup({ url: "javascript:alert(1)" });

    expect(screen.queryByRole("link")).toBeNull();
  });

  // #925
  it("approves with the note and says it is done", async () => {
    const { api, onChanged, user } = setup();

    await user.type(
      screen.getByLabelText("Note for the review (optional)"),
      "Looks good",
    );
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(api.review).toHaveBeenCalledWith({
      repositoryId: "r-1",
      number: 7,
      decision: "approve",
      comment: "Looks good",
    });
    const status = await screen.findByText(/Approved on GitHub/);
    expect(document.activeElement).toBe(status);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  // #925
  it("requests changes without a note, sending no comment", async () => {
    const { api, user } = setup();

    await user.click(screen.getByRole("button", { name: "Request changes" }));

    expect(api.review).toHaveBeenCalledWith({
      repositoryId: "r-1",
      number: 7,
      decision: "request_changes",
    });
    expect(
      await screen.findByText("Changes requested on GitHub."),
    ).toBeTruthy();
  });

  // #925
  it("tells a review that was posted before", async () => {
    const api = fakeApi({
      review: ok<ReviewOutcome>({ outcome: "already_there", reviewId: "5" }),
    });
    const { user } = setup({}, api);

    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText(/posted before/)).toBeTruthy();
  });

  // #925
  it("tells that the decision was written as a comment because the App opened the pull request, with the link to it", async () => {
    const api = fakeApi({
      review: ok<ReviewOutcome>({
        outcome: "commented",
        url: "https://github.com/acme/widgets/pull/7#issuecomment-1",
      }),
    });
    const { user } = setup({}, api);

    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText(/written as a comment/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open the comment on GitHub" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/pull/7#issuecomment-1");
  });

  // #925
  it.each([
    ["TODOS_REVIEW_NOT_REQUESTED", 404, /not asked of you/, true],
    ["TODOS_GITHUB_UNAVAILABLE", 409, /no GitHub connection/, false],
    ["TODOS_REVIEW_FAILED", 503, /try again in a moment/, false],
    ["TODOS_REQUEST_INVALID", 400, /at most 4000 characters/, false],
    ["TODOS_CROSS_SITE_REQUEST", 403, /Reload the page/, false],
  ])(
    "tells %s in words and keeps the buttons usable",
    async (code, status, words, reads) => {
      const api = fakeApi({ review: failed(code, status) });
      const { onChanged, user } = setup({}, api);

      await user.click(screen.getByRole("button", { name: "Request changes" }));

      expect((await screen.findByRole("alert")).textContent).toMatch(words);
      expect(onChanged).toHaveBeenCalledTimes(reads ? 1 : 0);
      expect(
        screen
          .getByRole("button", { name: "Approve" })
          .hasAttribute("disabled"),
      ).toBe(false);
    },
  );

  // #925
  it("posts one decision when both buttons are used while one is on its way", async () => {
    let release: () => void = () => {};
    const api = fakeApi();
    api.review.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve(ok<ReviewOutcome>({ outcome: "submitted", reviewId: "1" }));
        }),
    );
    const { user } = setup({}, api);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    // While it is on its way both buttons are off.
    expect(
      screen
        .getByRole("button", { name: "Request changes" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Request changes" }));

    expect(api.review).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  // #925
  it("shows no form for a review that is not open any more", () => {
    setup({}, fakeApi(), false);

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/not open any more/);
  });
});
