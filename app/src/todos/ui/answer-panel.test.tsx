// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The answer panel (#925): the question comment-styled, the options as choices, a note, "Answer" through the route of the run, one answer
// at a time, and the refusals of the route in words.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerForm } from "./answer-panel.tsx";
import type { TodoActor } from "./actor.ts";
import { ACTOR, failed, fakeApi, question } from "./test-fixtures.ts";

afterEach(cleanup);

function setup(
  over: Parameters<typeof question>[0] = {},
  api = fakeApi(),
  open = true,
  actor: TodoActor = ACTOR,
) {
  const onChanged = vi.fn();
  const form = (shown: boolean) => (
    <AnswerForm
      todo={question(over)}
      open={shown}
      actor={actor}
      api={api}
      onChanged={onChanged}
    />
  );
  const { rerender } = render(form(open));
  return {
    api,
    onChanged,
    user: userEvent.setup(),
    /** The page reads the list again: the same form with a new `open`. */
    show: ({ open: shown }: { open: boolean }) => rerender(form(shown)),
  };
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

  // #925
  it("moves the focus to the alert when the answer fails, so a keyboard user hears why", async () => {
    const { user } = setup(
      {},
      fakeApi({ answer: failed("NETWORK_ERROR", null) }),
    );

    await user.click(screen.getByRole("radio", { name: /Network errors$/ }));
    await user.click(screen.getByRole("button", { name: "Answer" }));

    const alert = await screen.findByRole("alert");
    expect(document.activeElement).toBe(alert);
  });

  // #925
  it("keeps what the person typed, with a way to copy it, when the question is not the open one any more", async () => {
    const { user, show } = setup();
    // `userEvent.setup()` has put its own clipboard in place: watch that one.
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("radio", { name: /Network errors$/ }));
    await user.type(
      screen.getByLabelText("Note for the agent (optional)"),
      "Back off twice",
    );

    // The page reads the list again and the question is not on it any more.
    show({ open: false });

    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    const kept = screen.getByRole("region", { name: "Your text" });
    expect(within(kept).getByText("Back off twice")).toBeTruthy();
    expect(within(kept).getByText(/Network errors/)).toBeTruthy();
    await user.click(within(kept).getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("Network errors\n\nBack off twice");
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  // #925
  it("shows no kept text when nothing was typed", () => {
    const { show } = setup();

    show({ open: false });

    expect(screen.queryByRole("region", { name: "Your text" })).toBeNull();
  });

  // #925
  it("shows the question but no form to a role that may not answer, with a sentence like the one of the run page", () => {
    setup({}, fakeApi(), true, { mayAct: false, hasLogin: true });

    expect(screen.getByText("Retry which failures?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe(
      "Your role in this workspace does not allow that.",
    );
  });

  // #925
  it("lets a choice be taken back", async () => {
    const { api, user } = setup();

    await user.click(screen.getByRole("radio", { name: /Network errors$/ }));
    await user.click(screen.getByRole("button", { name: "Clear choice" }));

    expect(
      (
        screen.getByRole("radio", {
          name: /Network errors$/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(screen.queryByRole("button", { name: "Clear choice" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Answer" }));
    expect(api.answer).not.toHaveBeenCalled();
  });

  // #925
  it("caps the note so that the option and the note together stay within what the route takes", async () => {
    const { api, user } = setup({ options: ["x".repeat(100), "short"] });
    const note = screen.getByLabelText(
      "Note for the agent (optional)",
    ) as HTMLTextAreaElement;

    expect(note.maxLength).toBe(4000);
    await user.click(screen.getByRole("radio", { name: /short/ }));
    // The option and the blank line that joins it to the note are counted.
    expect(note.maxLength).toBe(4000 - 5 - 2);
    fireEvent.change(note, { target: { value: "n".repeat(3950) } });
    // A longer option now makes the two too long together.
    await user.click(screen.getByRole("radio", { name: /x{100}/ }));
    expect(note.maxLength).toBe(4000 - 100 - 2);

    expect(
      screen.getByRole("button", { name: "Answer" }).hasAttribute("disabled"),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Answer" }));
    expect(api.answer).not.toHaveBeenCalled();
    expect(screen.getByText(/at most 4000 characters/)).toBeTruthy();
  });

  // #925
  it("does not name a GitHub login in the footnote of an account that has none", () => {
    setup({}, fakeApi(), true, { mayAct: true, hasLogin: false });

    expect(screen.getByText(/a member of the workspace/)).toBeTruthy();
    expect(screen.queryByText(/@login/)).toBeNull();
  });

  // #925
  it("names the login in the footnote of an account that has one", () => {
    setup();

    expect(screen.getByText(/Answer by @login/)).toBeTruthy();
  });
});
