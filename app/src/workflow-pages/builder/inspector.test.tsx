// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The inspector of the lane builder (#926): the fields of each kind of node, what an edit writes into the document, the validator's
// errors with their names and the one-click fix, and the buttons that remove and move a step.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { getAt, nodeAt, patchNode, type Doc } from "./document.ts";
import { Inspector, type ProfileOption } from "./inspector.tsx";
import { sortProblems, type Problem } from "./problems.ts";
import { REVIEW_INSTRUCTION } from "../../workflows/built-in-lanes.ts";
import type { ReachSamples } from "../../workflows/reach.ts";
import { answerOf, reachLookupFor, shippedLane } from "./test-fixtures.ts";

afterEach(cleanup);

const PROFILES: ProfileOption[] = [
  { name: "implementer", version: 2 },
  { name: "reviewer", version: 1 },
];

function Harness({
  start,
  pointer,
  problems = [],
  profiles = PROFILES,
  seen,
  samples,
  onRemove,
  onMove,
}: {
  start: Doc;
  pointer: string;
  problems?: Problem[];
  profiles?: ProfileOption[];
  seen?: (doc: Doc) => void;
  samples?: ReachSamples;
  onRemove?: () => void;
  onMove?: (direction: -1 | 1) => void;
}) {
  const [doc, setDoc] = useState(start);
  const sorted = sortProblems(problems);
  return (
    <Inspector
      doc={doc}
      pointer={pointer}
      problems={sorted.byNode.get(pointer) ?? []}
      profiles={profiles}
      lookup={(request) => reachLookupFor(doc, samples)(request)}
      headingRef={{ current: null }}
      onChange={(next) => {
        seen?.(next);
        setDoc(next);
      }}
      onRemove={onRemove ?? (() => {})}
      onMove={onMove ?? (() => {})}
    />
  );
}

function value(label: string | RegExp): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

describe("an agent step", () => {
  // #926-T32
  it("shows profile, session, start branch, instruction first and next in a loop, environment and result: no model, no key", () => {
    render(<Harness start={shippedLane()} pointer="/steps/1/body/0" />);
    expect(value("Profile")).toBe("implementer@1");
    expect(value("Session")).toBe("continue");
    expect(value("Continue the session of")).toBe("implement");
    expect(
      (screen.getByLabelText("Start branch") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(value("Instruction, first round")).toContain(
      "{{trigger.ticket.title}}",
    );
    expect(value("Instruction, next rounds")).toContain(
      "{{previous.review.findings}}",
    );
    expect(value("Environment")).toBe("node");
    expect(screen.getAllByText("target · literal")).toHaveLength(1);
    expect(screen.getAllByText("target · one value")).toHaveLength(1);
    const result = screen.getByRole("group", { name: "Result" });
    expect(within(result).getByDisplayValue("summary")).toBeTruthy();
    expect(screen.queryByLabelText(/model/i)).toBeNull();
    expect(screen.queryByLabelText(/key/i)).toBeNull();
  });

  // #926-T33
  it("writes an edit of the instruction into the document and nothing else", () => {
    const seen = vi.fn();
    const start = shippedLane();
    render(<Harness start={start} pointer="/steps/1/body/1" seen={seen} />);
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Review it carefully." },
    });
    const next = seen.mock.lastCall?.[0] as Doc;
    expect(getAt(next, "/steps/1/body/1/instruction")).toBe(
      "Review it carefully.",
    );
    expect(getAt(next, "/steps/1/body/0")).toBe(
      getAt(start, "/steps/1/body/0"),
    );
  });

  // #926-T34
  it("lets a step in a loop have a different instruction from round two, and go back to one", () => {
    const seen = vi.fn();
    render(
      <Harness start={shippedLane()} pointer="/steps/1/body/1" seen={seen} />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Different instruction from round two",
      }),
    );
    expect(
      getAt(seen.mock.lastCall?.[0] as Doc, "/steps/1/body/1/instruction"),
    ).toEqual({ first: REVIEW_INSTRUCTION, next: REVIEW_INSTRUCTION });
    expect(screen.getByLabelText("Instruction, next rounds")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Same instruction in every round" }),
    );
    expect(
      typeof getAt(
        seen.mock.lastCall?.[0] as Doc,
        "/steps/1/body/1/instruction",
      ),
    ).toBe("string");
  });

  // #926-T35
  it("offers the profiles of the workspace, newest and pinned, and keeps a value the list does not have", () => {
    render(<Harness start={shippedLane()} pointer="/steps/1/body/1" />);
    const options = within(screen.getByLabelText("Profile"))
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);
    expect(options).toContain("implementer");
    expect(options).toContain("implementer@2");
    expect(options).toContain("reviewer");
    expect(options.filter((option) => option === "reviewer@1")).toHaveLength(1);
    expect(value("Profile")).toBe("reviewer@1");
  });

  // #926-T36
  it("switches the session: a new session drops the start branch rule, a continued one names a step", () => {
    const seen = vi.fn();
    render(
      <Harness start={shippedLane()} pointer="/steps/1/body/0" seen={seen} />,
    );
    fireEvent.change(screen.getByLabelText("Session"), {
      target: { value: "new" },
    });
    expect(
      getAt(seen.mock.lastCall?.[0] as Doc, "/steps/1/body/0/session"),
    ).toBe("new");
    expect(
      (screen.getByLabelText("Start branch") as HTMLInputElement).disabled,
    ).toBe(false);
    fireEvent.change(screen.getByLabelText("Session"), {
      target: { value: "continue" },
    });
    expect(
      getAt(seen.mock.lastCall?.[0] as Doc, "/steps/1/body/0/session"),
    ).toEqual({ continue: "review" });
  });

  // #926-T36b
  it("keeps the start branch when the session goes on, and disables the field instead", () => {
    const seen = vi.fn();
    render(
      <Harness start={shippedLane()} pointer="/steps/1/body/0" seen={seen} />,
    );
    fireEvent.change(screen.getByLabelText("Session"), {
      target: { value: "new" },
    });
    fireEvent.change(screen.getByLabelText("Start branch"), {
      target: { value: "main" },
    });
    fireEvent.change(screen.getByLabelText("Session"), {
      target: { value: "continue" },
    });
    expect(
      getAt(seen.mock.lastCall?.[0] as Doc, "/steps/1/body/0/branch"),
    ).toBe("main");
    const branch = screen.getByLabelText("Start branch") as HTMLInputElement;
    expect(branch.disabled).toBe(true);
    expect(branch.value).toBe("main");
  });

  // #926-T37
  it("shows the environment only where the step has one, or where the validator asks for one", () => {
    const lane = shippedLane();
    const without = {
      ...lane,
      steps: [
        {
          id: "a",
          kind: "agent",
          profile: "reviewer",
          session: "new",
          instruction: "x",
        },
      ],
    };
    const { unmount } = render(<Harness start={without} pointer="/steps/0" />);
    expect(screen.queryByLabelText("Environment")).toBeNull();
    unmount();
    render(
      <Harness
        start={without}
        pointer="/steps/0"
        problems={[
          {
            path: "/steps/0/environment",
            code: "missing_field",
            message: "'environment' is required.",
          },
        ]}
      />,
    );
    expect(screen.getByLabelText("Environment")).toBeTruthy();
  });

  // #926-T37b
  it("removes the environment from the step when the field is cleared, so the profile's runner applies (#919)", () => {
    const lane = shippedLane();
    const seen = vi.fn();
    render(
      <Harness
        start={{
          ...lane,
          steps: [
            {
              id: "a",
              kind: "agent",
              profile: "reviewer",
              environment: "node",
              session: "new",
              instruction: "x",
            },
          ],
        }}
        pointer="/steps/0"
        seen={seen}
      />,
    );
    fireEvent.change(screen.getByLabelText("Environment"), {
      target: { value: "" },
    });
    const step = getAt(seen.mock.lastCall?.[0] as Doc, "/steps/0") as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(step, "environment")).toBe(false);
  });

  // #926-T38
  it("edits the result schema as a table", () => {
    const seen = vi.fn();
    render(
      <Harness start={shippedLane()} pointer="/steps/1/body/0" seen={seen} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add a field" }));
    expect(
      Object.keys(
        getAt(
          seen.mock.lastCall?.[0] as Doc,
          "/steps/1/body/0/result/properties",
        ) as object,
      ),
    ).toEqual(["summary", "field"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove field summary" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove field field" }));
    expect(
      getAt(seen.mock.lastCall?.[0] as Doc, "/steps/1/body/0/result"),
    ).toBeUndefined();
  });
});

describe("an action", () => {
  // #926-T39
  it("shows the inputs of its connector and marks the targets", () => {
    render(<Harness start={shippedLane()} pointer="/steps/0" />);
    expect(value("Connector")).toBe("ticket.labels");
    expect(value("ticket")).toBe("{{trigger.ticket}}");
    expect(value("add (optional)")).toBe("agent working");
    expect(value("remove (optional)")).toBe("agent implement");
    expect(screen.getAllByText("target · one value")).toHaveLength(3);
  });

  // #926-T40
  it("marks a target that takes a literal only, and does not mark free text", () => {
    const lane = {
      ...shippedLane(),
      steps: [
        {
          id: "s",
          kind: "action",
          connector: "ticket.setStatus",
          ticket: "{{trigger.ticket}}",
          board: "7",
          status: "Doing",
        },
      ],
    };
    const { unmount } = render(<Harness start={lane} pointer="/steps/0" />);
    expect(screen.getAllByText("target · literal")).toHaveLength(2);
    unmount();
    render(<Harness start={shippedLane()} pointer="/steps/2/else/0" />);
    expect(
      within(
        document.querySelector("[data-field=body]") as HTMLElement,
      ).queryByText(/target/),
    ).toBeNull();
  });

  // #926-T41b
  it("keeps what is typed in a list field while the list is written line by line", () => {
    const seen = vi.fn();
    render(<Harness start={shippedLane()} pointer="/steps/0" seen={seen} />);
    const field = () =>
      screen.getByLabelText("add (optional)") as HTMLTextAreaElement;
    const type = (text: string) =>
      fireEvent.change(field(), { target: { value: text } });
    type("a");
    type("a\n");
    expect(field().value).toBe("a\n");
    type("a\nb");
    type("a\nb\n\n");
    expect(field().value).toBe("a\nb\n\n");
    expect(getAt(seen.mock.lastCall?.[0] as Doc, "/steps/0/add")).toEqual([
      "a",
      "b",
    ]);
    type("{{trigger.input.labels}} ");
    expect(field().value).toBe("{{trigger.input.labels}} ");
    expect(getAt(seen.mock.lastCall?.[0] as Doc, "/steps/0/add")).toBe(
      "{{trigger.input.labels}}",
    );
    fireEvent.blur(field());
    expect(field().value).toBe("{{trigger.input.labels}}");
  });

  // #926-T41
  it("writes a list of labels one to a line and takes one reference for the whole list", () => {
    const seen = vi.fn();
    render(<Harness start={shippedLane()} pointer="/steps/0" seen={seen} />);
    fireEvent.change(screen.getByLabelText("add (optional)"), {
      target: { value: "a\nb" },
    });
    expect(getAt(seen.mock.lastCall?.[0] as Doc, "/steps/0/add")).toEqual([
      "a",
      "b",
    ]);
    fireEvent.change(screen.getByLabelText("add (optional)"), {
      target: { value: "{{trigger.input.labels}}" },
    });
    expect(getAt(seen.mock.lastCall?.[0] as Doc, "/steps/0/add")).toBe(
      "{{trigger.input.labels}}",
    );
    fireEvent.change(screen.getByLabelText("add (optional)"), {
      target: { value: "" },
    });
    expect(
      nodeAt(seen.mock.lastCall?.[0] as Doc, "/steps/0"),
    ).not.toHaveProperty("add");
  });

  // #926-T42
  it("changes the connector to the inputs of the new one", () => {
    const seen = vi.fn();
    render(<Harness start={shippedLane()} pointer="/steps/0" seen={seen} />);
    fireEvent.change(screen.getByLabelText("Connector"), {
      target: { value: "ticket.comment" },
    });
    expect(nodeAt(seen.mock.lastCall?.[0] as Doc, "/steps/0")).toEqual({
      id: "start",
      kind: "action",
      connector: "ticket.comment",
      ticket: "{{trigger.ticket}}",
      body: "",
    });
  });
});

describe("control nodes and triggers", () => {
  // #926-T43
  it("steps the max rounds of a loop between 1 and 10 and edits its until condition", () => {
    const seen = vi.fn();
    render(<Harness start={shippedLane()} pointer="/steps/1" seen={seen} />);
    expect(screen.getByLabelText("Max rounds value").textContent).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "More max rounds" }));
    expect(getAt(seen.mock.lastCall?.[0] as Doc, "/steps/1/maxRounds")).toBe(4);
    expect(
      (screen.getByLabelText("Until operator") as HTMLSelectElement).value,
    ).toBe("empty");
    fireEvent.change(screen.getByLabelText("Until operand"), {
      target: { value: "{{review.findings}} " },
    });
    expect(getAt(seen.mock.lastCall?.[0] as Doc, "/steps/1/until")).toEqual({
      empty: "{{review.findings}} ",
    });
  });

  // #926-T44b
  it("keeps a typed 3 a text, and makes it a number only where the person says number", () => {
    const seen = vi.fn();
    render(<Harness start={shippedLane()} pointer="/steps/2" seen={seen} />);
    const when = () => getAt(seen.mock.lastCall?.[0] as Doc, "/steps/2/when");
    fireEvent.change(screen.getByLabelText("When operand 2"), {
      target: { value: "3" },
    });
    expect(when()).toEqual({ equals: ["{{fix.exit}}", "3"] });
    fireEvent.change(screen.getByLabelText("When operand 2 type"), {
      target: { value: "number" },
    });
    expect(when()).toEqual({ equals: ["{{fix.exit}}", 3] });
    fireEvent.change(screen.getByLabelText("When operand 2"), {
      target: { value: "4" },
    });
    expect(when()).toEqual({ equals: ["{{fix.exit}}", 4] });
    fireEvent.change(screen.getByLabelText("When operand 2 type"), {
      target: { value: "boolean" },
    });
    expect(when()).toEqual({ equals: ["{{fix.exit}}", false] });
    fireEvent.change(screen.getByLabelText("When operand 2"), {
      target: { value: "true" },
    });
    expect(when()).toEqual({ equals: ["{{fix.exit}}", true] });
  });

  // #926-T44
  it("edits the condition of an if with an operator and its operands", () => {
    const seen = vi.fn();
    render(<Harness start={shippedLane()} pointer="/steps/2" seen={seen} />);
    expect(
      (screen.getByLabelText("When operator") as HTMLSelectElement).value,
    ).toBe("equals");
    expect(
      (screen.getByLabelText("When operand 1") as HTMLInputElement).value,
    ).toBe("{{fix.exit}}");
    fireEvent.change(screen.getByLabelText("When operand 2"), {
      target: { value: "maxRounds" },
    });
    expect(getAt(seen.mock.lastCall?.[0] as Doc, "/steps/2/when")).toEqual({
      equals: ["{{fix.exit}}", "maxRounds"],
    });
    fireEvent.change(screen.getByLabelText("When operator"), {
      target: { value: "all" },
    });
    expect(getAt(seen.mock.lastCall?.[0] as Doc, "/steps/2/when")).toEqual({
      all: [{ equals: ["{{fix.exit}}", "maxRounds"] }],
    });
    expect(
      screen.getByRole("button", { name: "Add a condition" }),
    ).toBeTruthy();
  });

  // #926-T45
  it("shows the label of a label trigger and the input of a manual one, and has no remove or move for a trigger", () => {
    const { unmount } = render(
      <Harness start={shippedLane()} pointer="/triggers/0" />,
    );
    expect(value("Kind")).toBe("ticket.labeled");
    expect(value("Label")).toBe("agent implement");
    expect(screen.queryByRole("button", { name: "Remove step" })).toBeNull();
    unmount();
    render(<Harness start={shippedLane()} pointer="/triggers/1" />);
    expect(value("Kind")).toBe("manual");
    expect(
      (
        within(screen.getByRole("group", { name: "Input" })).getByLabelText(
          "Input field name",
        ) as HTMLInputElement
      ).value,
    ).toBe("ticket");
  });

  // #926-T46
  it("edits the id and removes and moves a step", () => {
    const seen = vi.fn();
    const onRemove = vi.fn();
    const onMove = vi.fn();
    render(
      <Harness
        start={shippedLane()}
        pointer="/steps/0"
        seen={seen}
        onRemove={onRemove}
        onMove={onMove}
      />,
    );
    fireEvent.change(screen.getByLabelText("Id"), {
      target: { value: "begin" },
    });
    expect(getAt(seen.mock.lastCall?.[0] as Doc, "/steps/0/id")).toBe("begin");
    expect(
      (screen.getByRole("button", { name: "Move up" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    expect(onMove).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove step" }));
    expect(onRemove).toHaveBeenCalled();
  });
});

describe("the errors of a node", () => {
  // #926-T47
  it("shows the code, the path, the message and the available names as chips", () => {
    const lane = shippedLane();
    const broken = {
      ...lane,
      steps: [
        {
          id: "a",
          kind: "agent",
          profile: "nobody",
          environment: "node",
          session: "new",
          instruction: "x",
        },
      ],
    };
    render(
      <Harness
        start={broken}
        pointer="/steps/0"
        problems={answerOf(broken).errors}
      />,
    );
    const problem = screen.getByRole("group", {
      name: "Error profile_unknown",
    });
    expect(within(problem).getByText("/steps/0/profile")).toBeTruthy();
    expect(
      within(problem).getByText(/There is no profile 'nobody'/),
    ).toBeTruthy();
    const names = within(within(problem).getByLabelText("Available"))
      .getAllByText(/./)
      .map((chip) => chip.textContent);
    expect(names).toEqual(["implementer", "reviewer"]);
    expect(within(problem).queryByRole("button")).toBeNull();
  });

  // #926-T48
  it("fixes with one click where exactly one name would do", () => {
    const seen = vi.fn();
    const lane = shippedLane();
    const broken = {
      ...lane,
      steps: [
        {
          id: "a",
          kind: "agent",
          profile: "reviewer",
          environment: "nod",
          session: "new",
          instruction: "x",
        },
      ],
    };
    const problems: Problem[] = [
      {
        path: "/steps/0/environment",
        code: "environment_unknown",
        message: "There is no environment 'nod'.",
        available: ["node"],
      },
    ];
    render(
      <Harness
        start={broken}
        pointer="/steps/0"
        problems={problems}
        seen={seen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use “node”" }));
    expect(getAt(seen.mock.lastCall?.[0] as Doc, "/steps/0/environment")).toBe(
      "node",
    );
  });

  // #926-T49
  it("says to pick a step when no node is picked, and leaves the errors of the lane as a whole to the builder", () => {
    const problems: Problem[] = [
      {
        path: "/budgetUsd",
        code: "budget_above_maximum",
        message: "Too much.",
      },
    ];
    render(
      <Harness start={shippedLane()} pointer="/steps/9" problems={problems} />,
    );
    expect(
      screen.getByText("Pick a step in the flow to edit it."),
    ).toBeTruthy();
    expect(screen.queryByText("budget_above_maximum")).toBeNull();
  });
});

describe("references in the fields (#927)", () => {
  const picker = () => screen.getByRole("dialog", { name: /^Values for / });
  const references = () =>
    within(picker())
      .getAllByRole("option")
      .map((option) => option.getAttribute("data-reference"));

  // #927-T60
  it("shows the reference of a target input as its one chip, and the rule of the field", () => {
    render(<Harness start={shippedLane()} pointer="/steps/0" />);
    const field = document.querySelector("[data-field=ticket]") as HTMLElement;
    expect(within(field).getByText("Ticket · ticket")).toBeTruthy();
    expect(
      (
        within(field).getByRole("button", {
          name: "Insert a value into ticket",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(within(field).getByText(/exactly one value/)).toBeTruthy();
    expect(value("ticket")).toBe("{{trigger.ticket}}");
  });

  // #927-T61
  it("writes a picked value into the document exactly as {{…}} text, at the cursor", async () => {
    const seen = vi.fn();
    render(
      <Harness
        start={shippedLane()}
        pointer="/steps/1/body/0"
        seen={seen}
        samples={{ trigger: { ticket: { title: "Crash" } } }}
      />,
    );
    const field = screen.getByLabelText(
      "Instruction, first round",
    ) as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(0, 0);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Insert a value into Instruction, first round",
      }),
    );
    await userEvent.click(
      within(picker())
        .getAllByRole("option")
        .find(
          (option) =>
            option.getAttribute("data-reference") === "trigger.ticket.url",
        )!,
    );
    const next = getAt(
      seen.mock.lastCall?.[0] as Doc,
      "/steps/1/body/0/instruction",
    ) as { first: string };
    expect(next.first.startsWith("{{trigger.ticket.url}}")).toBe(true);
    expect(next.first).toBe(
      `{{trigger.ticket.url}}${(shippedLane() as { steps: { body?: { instruction: { first: string } }[] }[] }).steps[1]!.body![0]!.instruction.first}`,
    );
  });

  // #927-T62
  it("offers previous.* in the next-round instruction of a loop step and not in an action outside a loop", async () => {
    const { unmount } = render(
      <Harness start={shippedLane()} pointer="/steps/1/body/0" />,
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Insert a value into Instruction, next rounds",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^This loop/ }));
    expect(references()).toContain("previous.review.findings");
    const next = within(picker())
      .getAllByRole("option")
      .find(
        (option) =>
          option.getAttribute("data-reference") === "previous.review.findings",
      );
    unmount();
    expect(next).toBeTruthy();
    render(<Harness start={shippedLane()} pointer="/steps/0" />);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Insert a value into add (optional)",
      }),
    );
    expect(screen.queryByRole("button", { name: /^This loop/ })).toBeNull();
  });

  // #927-T63
  it("holds the start branch to its rule: a literal, or one value the field takes", async () => {
    render(<Harness start={shippedLane()} pointer="/steps/1/body/1" />);
    const field = document.querySelector("[data-field=branch]") as HTMLElement;
    expect(
      within(field).getByText("Steps before · implement.branch"),
    ).toBeTruthy();
    expect(within(field).getByText("target · one value")).toBeTruthy();
    await userEvent.click(
      within(field).getByRole("button", {
        name: "Remove Steps before · implement.branch",
      }),
    );
    await userEvent.click(
      within(field).getByRole("button", {
        name: "Insert a value into Start branch",
      }),
    );
    await within(field).findByRole("listbox", { name: "Values" });
    await userEvent.click(
      within(picker()).getByRole("button", { name: /^All values/ }),
    );
    expect(references()).toEqual([
      "trigger.ticket.repo.defaultBranch",
      "implement.branch",
    ]);
  });

  // #927-T64
  it("picks into the operands of a condition, with what the if can reach", async () => {
    const seen = vi.fn();
    render(<Harness start={shippedLane()} pointer="/steps/2" seen={seen} />);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Insert a value into When operand 2",
      }),
    );
    await screen.findByRole("listbox", { name: "Values" });
    await userEvent.type(
      within(picker()).getByRole("combobox", { name: "Search values" }),
      "rounds",
    );
    expect(references()).toContain("fix.rounds");
    await userEvent.click(
      within(picker())
        .getAllByRole("option")
        .find(
          (option) => option.getAttribute("data-reference") === "fix.rounds",
        )!,
    );
    expect(getAt(seen.mock.lastCall?.[0] as Doc, "/steps/2/when")).toEqual({
      equals: ["{{fix.exit}}", "until{{fix.rounds}}"],
    });
  });

  // #927-T65
  it("reads the scope of the body for the until of a loop", async () => {
    render(<Harness start={shippedLane()} pointer="/steps/1" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Insert a value into Until operand" }),
    );
    await screen.findByRole("listbox", { name: "Values" });
    await userEvent.click(
      screen.getByRole("button", { name: /^Steps before/ }),
    );
    expect(references()).toContain("review.findings");
  });

  // #927-T66
  it("keeps a number operand as a draft: clearing and a lone minus do not write 0, and the number comes back on blur", () => {
    const seen = vi.fn();
    render(<Harness start={shippedLane()} pointer="/steps/2" seen={seen} />);
    const when = () => getAt(seen.mock.lastCall?.[0] as Doc, "/steps/2/when");
    fireEvent.change(screen.getByLabelText("When operand 2 type"), {
      target: { value: "number" },
    });
    fireEvent.change(screen.getByLabelText("When operand 2"), {
      target: { value: "12" },
    });
    expect(when()).toEqual({ equals: ["{{fix.exit}}", 12] });
    const operand = screen.getByLabelText("When operand 2") as HTMLInputElement;
    fireEvent.change(operand, { target: { value: "" } });
    expect(operand.value).toBe("");
    expect(when()).toEqual({ equals: ["{{fix.exit}}", 12] });
    fireEvent.change(operand, { target: { value: "-" } });
    expect(operand.value).toBe("-");
    expect(when()).toEqual({ equals: ["{{fix.exit}}", 12] });
    fireEvent.change(operand, { target: { value: "-4" } });
    expect(when()).toEqual({ equals: ["{{fix.exit}}", -4] });
    expect(operand.value).toBe("-4");
    fireEvent.change(operand, { target: { value: "1." } });
    expect(operand.value).toBe("1.");
    expect(when()).toEqual({ equals: ["{{fix.exit}}", 1] });
    fireEvent.blur(operand);
    expect(operand.value).toBe("1");
    fireEvent.change(operand, { target: { value: "" } });
    fireEvent.blur(operand);
    expect(operand.value).toBe("0");
    expect(when()).toEqual({ equals: ["{{fix.exit}}", 0] });
  });

  // #927-T67
  it("lets go of a list draft that no longer stands for the value, also while the field has focus", () => {
    function Reset() {
      const [doc, setDoc] = useState<Doc>(shippedLane());
      return (
        <>
          <button
            type="button"
            onClick={() => setDoc(patchNode(doc, "/steps/0", { add: ["z"] }))}
          >
            elsewhere z
          </button>
          <button
            type="button"
            onClick={() =>
              setDoc(patchNode(doc, "/steps/0", { add: ["a", "b"] }))
            }
          >
            elsewhere a b
          </button>
          <Inspector
            doc={doc}
            pointer="/steps/0"
            problems={[]}
            profiles={PROFILES}
            lookup={reachLookupFor(doc)}
            headingRef={{ current: null }}
            onChange={setDoc}
            onRemove={() => {}}
            onMove={() => {}}
          />
        </>
      );
    }
    render(<Reset />);
    const add = screen.getByLabelText("add (optional)") as HTMLTextAreaElement;
    add.focus();
    fireEvent.change(add, { target: { value: "a\n\nb" } });
    expect(add.value).toBe("a\n\nb");
    fireEvent.click(screen.getByRole("button", { name: "elsewhere z" }));
    expect(add.value).toBe("z");
    fireEvent.click(screen.getByRole("button", { name: "elsewhere a b" }));
    expect(add.value).toBe("a\nb");
  });
});
