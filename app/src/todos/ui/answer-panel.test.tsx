// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The answer panel (#925): the question comment-styled, the options as choices, a note, "Answer" through the route of the run, one answer
// at a time, and the refusals of the route in words.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerForm } from "./answer-panel.tsx";
import { failed, fakeApi, question } from "./test-fixtures.ts";

afterEach(cleanup);

function setup(
  over: Parameters<typeof question>[0] = {},
  api = fakeApi(),
  open = true,
) {
  const onChanged = vi.fn();
  render(
    <AnswerForm
      todo={question(over)}
      open={open}
      api={api}
      onChanged={onChanged}
    />,
  );
  return { api, onChanged, user: userEvent.setup() };
}

describe("the answer panel", () => {
  // #925
  it("shows the question like a comment of the agent, with its context, lane, spend and ticket, all as text", () => {
    setup({
      context: "The upload client retries nothing yet.",
      question: "Retry <b>which</b> failures?",
    });

    expect(screen.getByText("The agent")).toBeTruthy();
    expect(screen.getByText("Retry <b>which</b> failures?")).toBeTruthy();
    expect(
      screen.getByText("The upload client retries nothing yet."),
    ).toBeTruthy();
    expect(screen.getByText("$0.75 of $5.00")).toBeTruthy();
    expect(screen.getByRole("link", { name: "#12" }).getAttribute("href")).toBe(
      "https://github.com/acme/widgets/issues/12",
    );
    expect(screen.getByText(/Retry failed uploads/)).toBeTruthy();
  });

  // #925
  it("offers the options as choices and a note, and sends the number of the option with the note", async () => {
    const { api, user } = setup();

    await user.click(
      screen.getByRole("radio", { name: /Network errors and 5xx answers/ }),
    );
    await user.type(
      screen.getByLabelText("Note for the agent (optional)"),
      "Back off twice",
    );
    await user.click(screen.getByRole("button", { name: "Answer" }));

    expect(api.answer).toHaveBeenCalledWith("wf-1", "run-1", {
      question: { stepRunId: "step-1", n: 1 },
      choice: 2,
      text: "Back off twice",
    });
  });

  // #925
  it("answers a question without options with a text", async () => {
    const { api, user } = setup({ options: [] });

    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    await user.type(screen.getByLabelText("Your answer"), "Only 5xx");
    await user.click(screen.getByRole("button", { name: "Answer" }));

    expect(api.answer).toHaveBeenCalledWith("wf-1", "run-1", {
      question: { stepRunId: "step-1", n: 1 },
      text: "Only 5xx",
    });
  });

  // #925
  it("does not send an empty answer", async () => {
    const { api, user } = setup();

    const button = screen.getByRole("button", { name: "Answer" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Choose an option or write an answer."),
    ).toBeTruthy();
    await user.click(button);

    expect(api.answer).not.toHaveBeenCalled();
  });

  // #925
  it("posts once when the button is clicked twice while the answer is on its way", async () => {
    let release: () => void = () => {};
    const api = fakeApi();
    api.answer.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, data: {} });
        }),
    );
    const { onChanged, user } = setup({}, api);

    await user.click(screen.getByRole("radio", { name: /Network errors$/ }));
    const button = screen.getByRole("button", { name: "Answer" });
    await user.dblClick(button);

    expect(api.answer).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("button", { name: "Sending the answer" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    await act(async () => release());
    expect(api.answer).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  // #925
  it("says the answer went on, moves the focus to that message and asks the page to read the list again", async () => {
    const { onChanged, user } = setup();

    await user.click(screen.getByRole("radio", { name: /Network errors$/ }));
    await user.click(screen.getByRole("button", { name: "Answer" }));

    const status = await screen.findByText(/The answer went to the agent/);
    expect(status.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(status);
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  // #925
  it.each([
    ["WORKFLOW_RUN_NOT_WAITING", /does not wait for an answer any more/, true],
    ["WORKFLOW_RUN_QUESTION_CHANGED", /already answered or replaced/, true],
    ["WORKFLOW_RUN_ANSWER_INVALID", /That answer cannot be used/, false],
  ])(
    "tells %s in words, keeps the note, and reads the list again only when the question is not the open one",
    async (code, words, reads) => {
      const api = fakeApi({
        answer: failed(code, code.endsWith("INVALID") ? 422 : 409),
      });
      const { onChanged, user } = setup({}, api);

      await user.click(screen.getByRole("radio", { name: /Network errors$/ }));
      await user.type(
        screen.getByLabelText("Note for the agent (optional)"),
        "my note",
      );
      await user.click(screen.getByRole("button", { name: "Answer" }));

      expect((await screen.findByRole("alert")).textContent).toMatch(words);
      expect(
        (
          screen.getByLabelText(
            "Note for the agent (optional)",
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("my note");
      expect(onChanged).toHaveBeenCalledTimes(reads ? 1 : 0);
      // The button works again: a refused answer can be sent again.
      expect(
        screen.getByRole("button", { name: "Answer" }).hasAttribute("disabled"),
      ).toBe(false);
    },
  );

  // #925
  it("explains a network failure without losing the answer", async () => {
    const api = fakeApi({ answer: failed("NETWORK_ERROR", null) });
    const { user } = setup({}, api);

    await user.click(screen.getByRole("radio", { name: /Network errors$/ }));
    await user.click(screen.getByRole("button", { name: "Answer" }));

    expect(
      (await screen.findByRole("alert")).textContent?.length,
    ).toBeGreaterThan(10);
    expect(
      (
        screen.getByRole("radio", {
          name: /Network errors$/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  // #925
  it("shows no form for a question that is not open any more", () => {
    setup({}, fakeApi(), false);

    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/not open any more/);
  });
});
