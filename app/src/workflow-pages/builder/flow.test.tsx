// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The flow of the lane builder (#926): the shipped lane "Issue to PR" laid out as the board shows it, the red count at the node an error
// belongs to, and the "+" that inserts a step.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAt, type Doc } from "./document.ts";
import { Flow } from "./flow.tsx";
import { sortProblems, type Problem } from "./problems.ts";
import { shippedLane } from "./test-fixtures.ts";

afterEach(cleanup);

function show(doc: Doc = shippedLane(), problems: Problem[] = []) {
  const onSelect = vi.fn();
  const onAdd = vi.fn();
  const view = render(
    <Flow
      doc={doc}
      selected="/steps/0"
      problems={sortProblems(problems)}
      onSelect={onSelect}
      onAdd={onAdd}
    />,
  );
  const node = (pointer: string) =>
    view.container.querySelector(`[data-node="${pointer}"]`) as HTMLElement;
  return { ...view, onSelect, onAdd, node };
}

describe("the flow of the shipped lane", () => {
  // #926-T23
  it("shows each trigger as a dashed group with its own pre-steps, then the shared steps in order", () => {
    const { container, node } = show();
    const groups = container.querySelectorAll("[data-group=trigger]");
    expect(groups).toHaveLength(2);
    expect(within(groups[0] as HTMLElement).getByText("labeled")).toBeTruthy();
    expect(within(groups[1] as HTMLElement).getByText("manual")).toBeTruthy();
    expect(
      groups[0]?.querySelector("[data-node='/triggers/0/steps/0']"),
    ).toBeNull();
    expect(
      groups[1]?.querySelector("[data-node='/triggers/1/steps/0']")
        ?.textContent,
    ).toContain("mark");
    expect(screen.getByText(/Shared steps · in order · 10 of 50/)).toBeTruthy();
    const order = [
      ...container.querySelectorAll(
        "[data-list='/steps'] > div > [data-node], [data-list='/steps'] > div > [data-container]",
      ),
    ].map(
      (entry) =>
        entry.getAttribute("data-node") ?? entry.getAttribute("data-container"),
    );
    expect(order).toEqual(["/steps/0", "loop", "if"]);
    expect(node("/triggers/1").textContent).toContain("input ticket");
  });

  // #926-T24
  it("shows a loop as a container with its body indented and a footer, and an if with then and else side by side", () => {
    const { container, node } = show();
    const loop = container.querySelector(
      "[data-container=loop]",
    ) as HTMLElement;
    expect(loop.querySelector("[data-list='/steps/1/body']")).toBeTruthy();
    expect(within(loop).getByText(/after 3 rounds/)).toBeTruthy();
    expect(node("/steps/1/body/0").textContent).toContain(
      "implementer@1 · continues implement",
    );
    expect(node("/steps/1").textContent).toContain(
      "up to 3 rounds · until empty review.findings",
    );

    const branch = container.querySelector(
      "[data-container=if]",
    ) as HTMLElement;
    const then = branch.querySelector("[data-branch=then]") as HTMLElement;
    const otherwise = branch.querySelector("[data-branch=else]") as HTMLElement;
    expect(
      then.querySelector("[data-node='/steps/2/then/0']")?.textContent,
    ).toContain("github.pullRequest.open");
    expect(
      otherwise.querySelector("[data-node='/steps/2/else/0']")?.textContent,
    ).toContain("ticket.comment");
    expect(node("/steps/2").textContent).toContain("fix.exit = until");
  });

  // #926-T25
  it("shows onFailure as a group of its own at the bottom", () => {
    const { container } = show();
    const group = container.querySelector(
      "[data-group=onFailure]",
    ) as HTMLElement;
    expect(group.querySelector("[data-node='/onFailure/0']")).toBeTruthy();
    expect(group.querySelector("[data-node='/onFailure/1']")).toBeTruthy();
    expect(
      screen.getByText(/On a technical failure · comments and labels only/),
    ).toBeTruthy();
  });

  // #926-T26
  it("says when an else has nothing in it and still offers a step there", () => {
    const { container, onAdd } = show(
      setAt(shippedLane(), "/steps/2/else", undefined),
    );
    const otherwise = container.querySelector(
      "[data-branch=else]",
    ) as HTMLElement;
    expect(within(otherwise).getByText("nothing, goes on")).toBeTruthy();
    fireEvent.click(
      within(otherwise).getByRole("button", { name: /Add a step to else/ }),
    );
    fireEvent.click(within(otherwise).getByRole("button", { name: "Action" }));
    expect(onAdd).toHaveBeenCalledWith("/steps/2/else", 0, "action");
  });
});

describe("what a card shows and does", () => {
  // #926-T27
  it("shows the count of the errors at that node only, with a name a screen reader can read", () => {
    const problems: Problem[] = [
      {
        path: "/steps/1/body/0/profile",
        code: "profile_unknown",
        message: "m",
      },
      {
        path: "/steps/1/body/0/environment",
        code: "environment_unknown",
        message: "m",
      },
      { path: "/steps/2/when", code: "condition_operand_type", message: "m" },
    ];
    const { node } = show(shippedLane(), problems);
    expect(
      within(node("/steps/1/body/0")).getByLabelText("2 errors").textContent,
    ).toBe("2");
    expect(within(node("/steps/2")).getByLabelText("1 error")).toBeTruthy();
    expect(within(node("/steps/1")).queryByLabelText(/error/)).toBeNull();
    expect(within(node("/steps/0")).queryByLabelText(/error/)).toBeNull();
  });

  // #926-T28
  it("selects a node when it is clicked and marks the selected one", () => {
    const { node, onSelect } = show();
    expect(node("/steps/0").getAttribute("aria-pressed")).toBe("true");
    expect(node("/steps/1/body/1").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(node("/steps/1/body/1"));
    expect(onSelect).toHaveBeenCalledWith("/steps/1/body/1");
  });
});

describe("the plus between cards", () => {
  // #926-T29
  it("inserts a step of the kind chosen right after that card, in the list the card is in", () => {
    const { onAdd } = show();
    fireEvent.click(
      screen.getByRole("button", { name: "Add a step after start" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Agent step" }));
    expect(onAdd).toHaveBeenLastCalledWith("/steps", 1, "agent");
    fireEvent.click(
      screen.getByRole("button", { name: "Add a step after review" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "If" }));
    expect(onAdd).toHaveBeenLastCalledWith("/steps/1/body", 2, "if");
    fireEvent.click(
      screen.getByRole("button", { name: "Add a step after mark" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Loop" }));
    expect(onAdd).toHaveBeenLastCalledWith("/triggers/1/steps", 1, "loop");
  });

  // #926-T30
  it("offers only comments, labels and if after a failure", () => {
    show();
    fireEvent.click(
      screen.getByRole("button", { name: "Add a step after release" }),
    );
    const kinds = within(
      screen.getByRole("group", {
        name: /Add a step after release: which kind/,
      }),
    )
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(kinds).toEqual(["Action", "If"]);
  });

  // #926-T31
  it("is off when the lane has the most steps it may", () => {
    const steps = Array.from({ length: 50 }, (_, index) => ({
      id: `s${String(index)}`,
      kind: "action",
    }));
    show({ triggers: [], steps });
    expect(
      screen
        .getByRole("button", { name: "Add a step after s0" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
