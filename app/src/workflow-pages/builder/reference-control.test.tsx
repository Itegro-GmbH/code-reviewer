// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The chips of a field and the picker under it (#927): references shown as chips, the + that opens the picker, what the picker lists and how
// it is used from the keyboard, and the field that takes exactly one value.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReachSamples, ReachWants } from "../../workflows/reach.ts";
import type { ReachLookup } from "./api.ts";
import { ReachProvider } from "./reach-context.tsx";
import { ReferenceControl } from "./reference-control.tsx";
import { reachLookupFor, shippedLane } from "./test-fixtures.ts";

afterEach(cleanup);

const SAMPLES: ReachSamples = {
  trigger: { ticket: { title: "Crash on start", number: 7 } },
  steps: { implement: { summary: "Fixed the start-up crash" } },
};

function Harness({
  start = "",
  at = "/steps/1/body/1",
  multiline = false,
  target,
  wants,
  lookup = reachLookupFor(shippedLane(), SAMPLES),
  seen,
}: {
  start?: string;
  at?: string;
  multiline?: boolean;
  target?: readonly string[];
  wants?: ReachWants;
  lookup?: ReachLookup;
  seen?: (text: string) => void;
}) {
  const [value, setValue] = useState(start);
  return (
    <ReachProvider lookup={lookup}>
      <ReferenceControl
        name="field"
        label="Instruction"
        at={at}
        value={value}
        multiline={multiline}
        {...(target === undefined ? {} : { target })}
        {...(wants === undefined ? {} : { wants })}
        onChange={(text) => {
          seen?.(text);
          setValue(text);
        }}
      />
    </ReachProvider>
  );
}

const field = () => screen.getByLabelText("Instruction") as HTMLInputElement;
const plus = () =>
  screen.getByRole("button", { name: "Insert a value into Instruction" });

async function openPicker() {
  await userEvent.click(plus());
  await screen.findByRole("dialog", { name: "Values for Instruction" });
  await screen.findByRole("listbox", { name: "Values" });
}

const optionNames = () =>
  screen
    .getAllByRole("option")
    .map((option) => option.getAttribute("data-reference"));

describe("the chips of a field", () => {
  // #927-T40
  it("show each reference of the text as a chip with its category and name, and keep the text as typed", () => {
    const seen = vi.fn();
    render(
      <Harness
        start="Fix {{trigger.ticket.title}} with {{implement.summary}}"
        seen={seen}
      />,
    );
    const chips = within(
      screen.getByRole("list", { name: "Values in Instruction" }),
    ).getAllByText(/·/);
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "Ticket · title",
      "Steps before · implement.summary",
    ]);
    expect(field().value).toBe(
      "Fix {{trigger.ticket.title}} with {{implement.summary}}",
    );
    expect(seen).not.toHaveBeenCalled();
  });

  // #927-T41
  it("turn text typed as {{…}} into a chip, and leave a half typed one as text", () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: "x {{trigger.tic" } });
    expect(
      screen.queryByRole("list", { name: "Values in Instruction" }),
    ).toBeNull();
    fireEvent.change(field(), {
      target: { value: "x {{trigger.ticket.url}}" },
    });
    expect(screen.getByText("Ticket · url")).toBeTruthy();
    expect(field().value).toBe("x {{trigger.ticket.url}}");
  });

  // #927-T42
  it("remove only the chip whose cross is pressed", async () => {
    const seen = vi.fn();
    render(
      <Harness start="a {{x.y}} b {{trigger.ticket.title}} c" seen={seen} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Ticket · title" }),
    );
    expect(seen).toHaveBeenLastCalledWith("a {{x.y}} b  c");
    expect(screen.queryByText("Ticket · title")).toBeNull();
    expect(screen.getByText("Steps before · x.y")).toBeTruthy();
  });
});

describe("the picker", () => {
  // #927-T43
  it("opens under the field with search, categories and values with their type and a sample of the last run", async () => {
    render(<Harness />);
    expect(plus().getAttribute("aria-expanded")).toBe("false");
    await openPicker();
    expect(plus().getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", {
      name: "Values for Instruction",
    });
    expect(
      within(dialog).getByRole("combobox", { name: "Search values" }),
    ).toBeTruthy();
    const categories = within(
      within(dialog).getByRole("group", { name: "Categories" }),
    )
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(categories[0]).toMatch(/^All values/);
    expect(categories.join(" ")).toMatch(/Ticket/);
    expect(categories.join(" ")).toMatch(/Steps before/);
    expect(categories.join(" ")).toMatch(/This loop/);
    expect(categories.join(" ")).toMatch(/Lane and run/);
    expect(categories.join(" ")).not.toMatch(/Failure/);
    const title = within(dialog)
      .getAllByRole("option")
      .find(
        (option) =>
          option.getAttribute("data-reference") === "trigger.ticket.title",
      );
    expect(title?.textContent).toContain("title");
    expect(title?.textContent).toContain("text");
    expect(title?.textContent).toContain("last run: Crash on start");
    expect(
      within(dialog).getByText(/Samples are from the latest run/),
    ).toBeTruthy();
  });

  // #927-T44
  it("lists the values of the picked category, and all of them while searching", async () => {
    render(<Harness />);
    await openPicker();
    await userEvent.click(
      screen.getByRole("button", { name: /^Steps before/ }),
    );
    expect(optionNames().every((name) => !name?.startsWith("trigger."))).toBe(
      true,
    );
    expect(optionNames()).toContain("implement.summary");
    await userEvent.type(
      screen.getByRole("combobox", { name: "Search values" }),
      "crash",
    );
    expect(optionNames()).toContain("trigger.ticket.title");
    expect(optionNames()).toContain("implement.summary");
    expect(optionNames()).not.toContain("trigger.ticket.number");
    await userEvent.clear(
      screen.getByRole("combobox", { name: "Search values" }),
    );
    await userEvent.type(
      screen.getByRole("combobox", { name: "Search values" }),
      "zzzz",
    );
    expect(screen.getByText("No value matches “zzzz”.")).toBeTruthy();
  });

  // #927-T45
  it("offers previous.* inside a loop body and not outside it", async () => {
    const inside = render(<Harness at="/steps/1/body/1/instruction/next" />);
    await openPicker();
    await userEvent.click(screen.getByRole("button", { name: /^This loop/ }));
    expect(optionNames()).toContain("previous.implement.summary");
    inside.unmount();
    render(<Harness at="/steps/0" />);
    await openPicker();
    expect(screen.queryByRole("button", { name: /^This loop/ })).toBeNull();
    await userEvent.type(
      screen.getByRole("combobox", { name: "Search values" }),
      "previous",
    );
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  // #927-T46
  it("inserts the value where the cursor is, and puts the cursor behind it and focus back in the field", async () => {
    const seen = vi.fn();
    render(<Harness start="Fix  now" seen={seen} multiline />);
    field().focus();
    field().setSelectionRange(4, 4);
    await openPicker();
    await userEvent.click(
      screen
        .getAllByRole("option")
        .find(
          (option) =>
            option.getAttribute("data-reference") === "trigger.ticket.title",
        )!,
    );
    expect(seen).toHaveBeenLastCalledWith("Fix {{trigger.ticket.title}} now");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(field().selectionStart).toBe("Fix {{trigger.ticket.title}}".length);
  });

  // #927-R09
  it("closes with the + as it opened with it: a press on the + while the picker is open closes it and it stays closed", async () => {
    render(<Harness />);
    await openPicker();
    await userEvent.click(plus());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(plus().getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(plus());
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.mouseDown(plus());
    plus().focus();
    fireEvent.click(plus());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // #927-R10
  it("inserts where the caret is when the value is picked, not where it was when the picker opened", async () => {
    const seen = vi.fn();
    render(<Harness start="ab cd" seen={seen} />);
    field().focus();
    field().setSelectionRange(0, 0);
    await openPicker();
    field().setSelectionRange(5, 5);
    await userEvent.click(
      screen
        .getAllByRole("option")
        .find(
          (option) =>
            option.getAttribute("data-reference") === "trigger.ticket.title",
        )!,
    );
    expect(seen).toHaveBeenLastCalledWith("ab cd{{trigger.ticket.title}}");
  });

  // #927-R11
  it("never puts the value inside a reference or right after a backslash", async () => {
    const seen = vi.fn();
    render(<Harness start={"a {{x.y}} b \\"} seen={seen} />);
    field().focus();
    field().setSelectionRange(5, 5);
    await openPicker();
    await userEvent.click(
      screen
        .getAllByRole("option")
        .find(
          (option) =>
            option.getAttribute("data-reference") === "trigger.ticket.title",
        )!,
    );
    expect(seen).toHaveBeenLastCalledWith(
      "a {{trigger.ticket.title}}{{x.y}} b \\",
    );
    field().focus();
    field().setSelectionRange(field().value.length, field().value.length);
    await openPicker();
    await userEvent.click(
      screen
        .getAllByRole("option")
        .find(
          (option) =>
            option.getAttribute("data-reference") === "trigger.ticket.number",
        )!,
    );
    expect(seen).toHaveBeenLastCalledWith(
      "a {{trigger.ticket.title}}{{x.y}} b {{trigger.ticket.number}}\\",
    );
  });

  // #927-R12
  it("announces how many values are listed, in a live region that exists before it is filled", async () => {
    render(<Harness />);
    await userEvent.click(plus());
    const region = document.querySelector("[data-slot='match-count']")!;
    expect(region.getAttribute("aria-live")).toBe("polite");
    await screen.findByRole("listbox", { name: "Values" });
    await waitFor(() => expect(region.textContent).toMatch(/^\d+ values$/));
    await userEvent.type(
      screen.getByRole("combobox", { name: "Search values" }),
      "ticket.title",
    );
    expect(region.textContent).toBe("1 value");
    await userEvent.type(
      screen.getByRole("combobox", { name: "Search values" }),
      "zzzz",
    );
    expect(region.textContent).toBe("0 values");
  });

  // #927-R13
  it("asks for the kind of value the field takes, lists only those, and says what the others are for", async () => {
    const lookup = vi.fn(reachLookupFor(shippedLane()));
    render(<Harness wants="text" at="/steps/1" lookup={lookup} />);
    await openPicker();
    expect(lookup).toHaveBeenCalledWith(
      { at: "/steps/1", wants: "text" },
      expect.any(AbortSignal),
    );
    expect(optionNames()).not.toContain("trigger.ticket");
    expect(optionNames()).toContain("trigger.ticket.title");
    expect(
      within(screen.getByRole("dialog")).getByText(/Takes text/),
    ).toBeTruthy();
  });

  // #927-R14
  it("says that the validator still checks the type where the field takes any value", async () => {
    render(<Harness />);
    await openPicker();
    expect(
      within(screen.getByRole("dialog")).getByText(
        /the validator still checks that their type fits/,
      ),
    ).toBeTruthy();
  });

  // #927-T47
  it("is used from the keyboard: type, arrow down, Enter; Escape closes it and focus returns to the field", async () => {
    const seen = vi.fn();
    render(<Harness start="" seen={seen} />);
    await userEvent.click(field());
    await userEvent.keyboard("{Tab}{Enter}");
    await screen.findByRole("dialog");
    const search = screen.getByRole("combobox", { name: "Search values" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    await userEvent.type(search, "ticket.title");
    expect(search.getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[0]?.id,
    );
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{Enter}");
    expect(seen).toHaveBeenLastCalledWith("{{trigger.ticket.title}}");
    await waitFor(() => expect(document.activeElement).toBe(field()));

    await userEvent.click(plus());
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  // #927-T48
  it("moves among the categories with the arrow keys and closes on a click outside", async () => {
    render(
      <div>
        <button type="button">elsewhere</button>
        <Harness />
      </div>,
    );
    await openPicker();
    const all = screen.getByRole("button", { name: /^All values/ });
    all.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      within(screen.getByRole("group", { name: "Categories" })).getAllByRole(
        "button",
      )[1],
    );
    await userEvent.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // #927-T49
  it("says so when the values cannot be loaded, and does not break the field", async () => {
    const lookup: ReachLookup = () =>
      Promise.resolve({ ok: false, status: 500, code: "X", issues: [] });
    render(<Harness lookup={lookup} start="keep" />);
    await userEvent.click(plus());
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Could not load/,
    );
    expect(field().value).toBe("keep");
  });

  // #927-T50
  it("asks for the node the field is in, with the roots a target takes", async () => {
    const lookup = vi.fn(reachLookupFor(shippedLane()));
    render(
      <Harness at="/steps/0" target={["issue", "ticket"]} lookup={lookup} />,
    );
    await openPicker();
    expect(lookup).toHaveBeenCalledWith(
      { at: "/steps/0", targetRoots: ["issue", "ticket"] },
      expect.any(AbortSignal),
    );
  });
});

describe("a field that takes one value", () => {
  // #927-T51
  it("shows its reference as the one chip, greys the + out and explains the rule", () => {
    render(
      <Harness
        start="{{trigger.ticket}}"
        target={["issue", "ticket"]}
        at="/steps/0"
      />,
    );
    expect(screen.getByText("Ticket · ticket")).toBeTruthy();
    expect((plus() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("target · one value")).toBeTruthy();
    expect(
      screen.getByText(
        /Takes a literal or exactly one value: the issue that started the run, or the ticket the run is about/,
      ),
    ).toBeTruthy();
    expect(field().value).toBe("{{trigger.ticket}}");
  });

  // #927-T52
  it("lists only what the field takes, replaces a literal with the picked value, and takes no second one", async () => {
    const seen = vi.fn();
    render(
      <Harness
        start="1"
        seen={seen}
        target={["issue", "ticket"]}
        at="/steps/0"
      />,
    );
    await openPicker();
    expect(optionNames()).toEqual(["trigger.ticket", "trigger.ticket.number"]);
    expect(
      within(screen.getByRole("dialog")).getByText(/Nothing else is offered/),
    ).toBeTruthy();
    await userEvent.click(screen.getAllByRole("option")[1]!);
    expect(seen).toHaveBeenLastCalledWith("{{trigger.ticket.number}}");
    expect((plus() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(plus());
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Ticket · number" }),
    );
    expect(seen).toHaveBeenLastCalledWith("");
    expect((plus() as HTMLButtonElement).disabled).toBe(false);
  });

  // #927-R15
  it("takes no tab stop for the hidden box while the chip is shown, and puts focus on the chip after a pick", async () => {
    render(<Harness start="{{trigger.ticket}}" target={["ticket"]} />);
    expect(field().tabIndex).toBe(-1);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Ticket · ticket" }),
    );
    expect(field().tabIndex).toBe(0);
    await openPicker();
    await userEvent.click(screen.getAllByRole("option")[0]!);
    expect(field().tabIndex).toBe(-1);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Remove Ticket · ticket" }),
      ),
    );
  });

  // #927-T53
  it("greys the + out also for a text typed with two references, so no second chip is added", () => {
    render(
      <Harness start="{{trigger.ticket}} {{trigger.id}}" target={["ticket"]} />,
    );
    expect((plus() as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(
        screen.getByRole("list", { name: "Values in Instruction" }),
      ).getAllByText(/·/),
    ).toHaveLength(2);
  });

  // #927-T54
  it("has no picker for a field that takes a literal only", () => {
    render(<Harness start="main" target={[]} />);
    expect((plus() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("target · literal")).toBeTruthy();
    expect(screen.getByText(/Takes a literal only/)).toBeTruthy();
  });
});
