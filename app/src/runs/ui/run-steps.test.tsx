// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// "What the agent did" on the detail page of a run of the Implementer (#745, live view): the timeline of model calls with the
// thinking collapsed, the words visible and each tool call as one line; a part that changed is replaced in place; the follow
// switch; the marks of a cut text and of a shortened turn; text rendered as text; a long turn rendered in part; the poll of the
// run as the clock; a settled run fetched only when it is opened.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type { StepsSnapshot, StepView } from "../steps-view.ts";
import type { RunsApi } from "./api.ts";
import { RunSteps } from "./run-steps.tsx";

afterEach(cleanup);

const RUN = "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11";

const part = (
  partId: string,
  seq: number,
  extra: Partial<StepView> = {},
): StepView => ({
  partId,
  seq,
  ordinal: seq,
  kind: "text",
  ...extra,
});
const tokens = {
  input: 1200,
  output: 80,
  reasoning: 0,
  cacheRead: 900,
  cacheWrite: 0,
};

const answer = (
  steps: StepView[],
  options: { cursor?: number; hasMore?: boolean } = {},
): RequestResult<StepsSnapshot> => ({
  ok: true,
  data: {
    steps,
    cursor: options.cursor ?? Math.max(0, ...steps.map((s) => s.seq)),
    hasMore: options.hasMore ?? false,
  },
});

function apiAnswering(...answers: RequestResult<StepsSnapshot>[]) {
  const steps = vi.fn<RunsApi["steps"]>(async () => {
    const next = answers.length > 1 ? answers.shift() : answers[0];
    return next ?? answer([]);
  });
  return { api: { steps } as unknown as RunsApi, steps };
}

async function show(
  api: RunsApi,
  props: { tick?: string; settled?: boolean; showCost?: boolean } = {},
) {
  const view = render(
    <RunSteps
      api={api}
      runId={RUN}
      tick={props.tick ?? "t1"}
      settled={props.settled ?? false}
      showCost={props.showCost ?? true}
    />,
  );
  await act(async () => {});
  return {
    ...view,
    again: async (tick: string) => {
      view.rerender(
        <RunSteps
          api={api}
          runId={RUN}
          tick={tick}
          settled={props.settled ?? false}
          showCost={props.showCost ?? true}
        />,
      );
      await act(async () => {});
    },
  };
}

const TURN = [
  part("prt_1", 1, {
    kind: "reasoning",
    text: "I should look at the router first.",
  }),
  part("prt_2", 2, { text: "I will read the router." }),
  part("prt_3", 3, {
    kind: "tool",
    tool: "read",
    status: "completed",
    title: "src/router.ts",
    input: '{"filePath":"src/router.ts"}',
    startedAt: 1_000,
    endedAt: 1_400,
  }),
  part("prt_4", 4, {
    kind: "step",
    tokens,
    cost: 0.0123,
    reason: "tool-calls",
    startedAt: 900,
    endedAt: 3_400,
  }),
];

describe("the timeline", () => {
  // #745-T70
  it("shows a step header with tokens, time and cost, the words open, the thinking collapsed and a tool call as one line", async () => {
    const { api } = apiAnswering(answer(TURN));

    await show(api);

    const step = screen
      .getByRole("heading", { name: /Step 1/ })
      .closest("li") as HTMLElement;
    expect(
      within(step).getByText(
        /1,200 in · 80 out · 900 cached · 2 s · \$0\.0123/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("I will read the router.")).toBeTruthy();
    const thinking = screen
      .getByText("Thinking")
      .closest("details") as HTMLDetailsElement;
    expect(thinking.open).toBe(false);
    const tool = document.querySelector(
      '[data-slot="run-step-tool"]',
    ) as HTMLElement;
    expect(tool.textContent).toContain("read");
    expect(tool.textContent).toContain("src/router.ts");
    expect(tool.textContent).toContain("done");
    expect(tool.textContent).toContain("under 1 s");
  });

  // #745-T70
  it("keeps the input of a tool call in a collapsed block and shows the error text of a failed call", async () => {
    const { api } = apiAnswering(
      answer([
        part("prt_1", 1, {
          kind: "tool",
          tool: "bash",
          status: "error",
          title: "npm test",
          input: '{"command":"npm test"}',
          error: "exit code 1",
          startedAt: 0,
          endedAt: 12_000,
        }),
      ]),
    );

    await show(api);

    const input = document.querySelector(
      '[data-slot="run-step-input"]',
    ) as HTMLDetailsElement;
    expect(input.open).toBe(false);
    expect(input.textContent).toContain('{"command":"npm test"}');
    const line = document.querySelector(
      '[data-slot="run-step-tool"]',
    ) as HTMLElement;
    expect(line.textContent).toContain("failed");
    expect(line.textContent).toContain("12 s");
    expect(screen.getByText("exit code 1")).toBeTruthy();
  });

  // #745-T70
  it("shows no cost where the page shows none", async () => {
    const { api } = apiAnswering(answer(TURN));

    await show(api, { showCost: false });

    expect(screen.getByText(/1,200 in · 80 out/).textContent).not.toContain(
      "$",
    );
  });

  // #745-T70
  it("shows a model call that is not over as in progress", async () => {
    const { api } = apiAnswering(
      answer([part("prt_1", 1, { text: "Working on it." })]),
    );

    await show(api);

    expect(
      screen.getByRole("heading", { name: /Step 1/ }).textContent,
    ).toContain("in progress");
  });

  // #745-T71
  it("renders what the agent wrote as plain text: no markup, no markdown, no link", async () => {
    const { api } = apiAnswering(
      answer([
        part("prt_1", 1, {
          text: '<img src=x onerror="alert(1)"> **bold** [a link](https://evil.example)',
        }),
        part("prt_2", 2, {
          kind: "reasoning",
          text: "<script>alert(2)</script>",
        }),
      ]),
    );

    await show(api);

    const region = screen.getByRole("region", { name: "Steps of the agent" });
    expect(region.querySelector("img, script, a, strong")).toBeNull();
    expect(region.textContent).toContain(
      '<img src=x onerror="alert(1)"> **bold** [a link](https://evil.example)',
    );
    expect(region.textContent).toContain("<script>alert(2)</script>");
  });

  // #745-T72
  it("shows 'cut, N bytes' for a text, a title and an input that the runner cut", async () => {
    const { api } = apiAnswering(
      answer([
        part("prt_1", 1, { text: "A long answer\n[2048 bytes cut]" }),
        part("prt_2", 2, {
          kind: "tool",
          tool: "write",
          status: "completed",
          input: '{"content":"abc\n[9000 bytes cut]',
        }),
      ]),
    );

    await show(api);

    expect(screen.getByText("cut, 2,048 bytes")).toBeTruthy();
    expect(screen.queryByText(/\[2048 bytes cut\]/)).toBeNull();
    expect(screen.getByText("A long answer")).toBeTruthy();
  });

  // #745-T72
  it("says the log was shortened once a tool call is kept as name and status only", async () => {
    const { api } = apiAnswering(
      answer([
        part("prt_1", 1, {
          kind: "tool",
          tool: "bash",
          status: "completed",
          input: "{}",
        }),
        part("prt_2", 2, { kind: "tool", tool: "bash", status: "completed" }),
      ]),
    );

    await show(api);

    expect(
      document.querySelector('[data-slot="run-steps-shortened"]')?.textContent,
    ).toContain("shortened");
  });

  // #745-T73
  it("renders only the newest model calls of a long turn and shows the earlier ones on request", async () => {
    const records: StepView[] = [];
    for (let i = 0; i < 300; i += 1) {
      records.push(
        part(`t${String(i)}`, 3 * i + 1, {
          text: `Words of call ${String(i + 1)}`,
        }),
      );
      records.push(
        part(`k${String(i)}`, 3 * i + 2, {
          kind: "tool",
          tool: "bash",
          status: "completed",
          input: "{}",
        }),
      );
      records.push(part(`e${String(i)}`, 3 * i + 3, { kind: "step", tokens }));
    }
    const { api } = apiAnswering(answer(records));

    await show(api);

    expect(
      document.querySelectorAll('[data-slot="run-step"]').length,
    ).toBeLessThan(300);
    expect(screen.getByText("Words of call 300")).toBeTruthy();
    expect(screen.queryByText("Words of call 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show earlier steps/ }));
    fireEvent.click(screen.getByRole("button", { name: /Show earlier steps/ }));

    expect(document.querySelectorAll('[data-slot="run-step"]').length).toBe(
      300,
    );
    expect(
      screen.queryByRole("button", { name: /Show earlier steps/ }),
    ).toBeNull();
  });
});

describe("the poll", () => {
  // #745-T74
  it("asks once at the start and once for each new snapshot of the run, after the cursor it got", async () => {
    const { api, steps } = apiAnswering(
      answer([part("prt_1", 1, { text: "First." })]),
      answer([part("prt_2", 2, { text: "Second." })]),
      answer([]),
    );

    const view = await show(api, { tick: "t1" });
    await view.again("t2");
    await view.again("t3");

    expect(steps.mock.calls).toEqual([
      [RUN, 0],
      [RUN, 1],
      [RUN, 2],
    ]);
    expect(screen.getByText("First.")).toBeTruthy();
    expect(screen.getByText("Second.")).toBeTruthy();
  });

  // #745-T74
  it("follows the cursor through pages while more are waiting", async () => {
    const { api, steps } = apiAnswering(
      answer([part("prt_1", 1, { text: "One." })], { hasMore: true }),
      answer([part("prt_2", 2, { text: "Two." })]),
    );

    await show(api);

    expect(steps.mock.calls.map((call) => call[1])).toEqual([0, 1]);
    expect(screen.getByText("Two.")).toBeTruthy();
  });

  // #745-T75
  it("replaces a part that changed in its place instead of adding a second row", async () => {
    const running = part("prt_t", 1, {
      kind: "tool",
      tool: "bash",
      status: "running",
      title: "npm test",
      input: "{}",
    });
    const done = {
      ...running,
      seq: 3,
      status: "completed",
      endedAt: 5_000,
      startedAt: 1_000,
    };
    const { api } = apiAnswering(
      answer([running, part("prt_x", 2, { text: "Waiting for the tests." })]),
      answer([done]),
    );

    const view = await show(api, { tick: "t1" });
    expect(
      document.querySelector('[data-slot="run-step-tool"]')?.textContent,
    ).toContain("running");
    await view.again("t2");

    const lines = document.querySelectorAll('[data-slot="run-step-tool"]');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toContain("done");
    expect(lines[0]?.textContent).toContain("4 s");
    // It kept its place before the words that came after it.
    const order = [
      ...document.querySelectorAll(
        '[data-slot="run-step-tool"], [data-slot="run-step-text"]',
      ),
    ].map((element) => element.getAttribute("data-slot"));
    expect(order).toEqual(["run-step-tool", "run-step-text"]);
  });

  // #745-T76
  it("does not close a block the person opened when the part is replaced", async () => {
    const running = part("prt_t", 1, {
      kind: "tool",
      tool: "bash",
      status: "running",
      input: '{"command":"ls"}',
    });
    const { api } = apiAnswering(
      answer([running]),
      answer([{ ...running, seq: 2, status: "completed" }]),
    );
    const view = await show(api, { tick: "t1" });
    const input = document.querySelector(
      '[data-slot="run-step-input"]',
    ) as HTMLDetailsElement;
    input.open = true;

    await view.again("t2");

    expect(
      (
        document.querySelector(
          '[data-slot="run-step-input"]',
        ) as HTMLDetailsElement
      ).open,
    ).toBe(true);
  });

  // #745-T77
  it("keeps the steps on screen when an update fails, says so, and goes on at the next snapshot", async () => {
    const { api } = apiAnswering(
      answer([part("prt_1", 1, { text: "Before the failure." })]),
      { ok: false, status: 500, code: "NETWORK_ERROR", issues: [] },
      answer([part("prt_2", 2, { text: "After it." })]),
    );

    const view = await show(api, { tick: "t1" });
    await view.again("t2");
    expect(screen.getByText("Before the failure.")).toBeTruthy();
    expect(
      document.querySelector('[data-slot="run-steps-failed"]')?.textContent,
    ).toContain("last steps");
    await view.again("t3");

    expect(document.querySelector('[data-slot="run-steps-failed"]')).toBeNull();
    expect(screen.getByText("After it.")).toBeTruthy();
  });

  // #745-T77
  it("stops asking when the run is gone", async () => {
    const { api, steps } = apiAnswering({
      ok: false,
      status: 404,
      code: "RUN_NOT_FOUND",
      issues: [],
    });

    const view = await show(api, { tick: "t1" });
    await view.again("t2");

    expect(steps).toHaveBeenCalledTimes(1);
  });

  // #745-T78
  it("says it is waiting while a run has no step yet, and that there are none once it is settled", async () => {
    const waiting = apiAnswering(answer([]));
    const first = await show(waiting.api, { settled: false });
    expect(
      document.querySelector('[data-slot="run-steps-empty"]')?.textContent,
    ).toContain("Waiting");
    first.unmount();

    const done = apiAnswering(answer([]));
    const second = await show(done.api, { settled: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Show what the agent did" }),
    );
    await act(async () => {});
    expect(
      document.querySelector('[data-slot="run-steps-empty"]')?.textContent,
    ).toContain("no steps");
    second.unmount();
  });
});

describe("a settled run", () => {
  // #745-T79
  it("asks for nothing until the section is opened, then asks once", async () => {
    const { api, steps } = apiAnswering(answer(TURN));

    const view = await show(api, { settled: true });
    expect(steps).not.toHaveBeenCalled();
    expect(screen.queryByText("I will read the router.")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Show what the agent did" }),
    );
    await act(async () => {});

    expect(steps).toHaveBeenCalledTimes(1);
    expect(screen.getByText("I will read the router.")).toBeTruthy();
    view.unmount();
  });
});

describe("the follow switch", () => {
  function scrollSpy() {
    const heights = new Map<Element, number>();
    const assigned: number[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 1234;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return heights.get(this as Element) ?? 0;
      },
      set(value: number) {
        heights.set(this as Element, value);
        assigned.push(value);
      },
    });
    return assigned;
  }
  afterEach(() => {
    // @ts-expect-error -- remove the stand-ins again so the next test sees the plain prototype
    delete HTMLElement.prototype.scrollHeight;
    // @ts-expect-error -- as above
    delete HTMLElement.prototype.scrollTop;
  });

  // #745-T80
  it("is on for a run that is going on and moves the view to the end when steps arrive", async () => {
    const assigned = scrollSpy();
    const { api } = apiAnswering(
      answer([part("prt_1", 1, { text: "One." })]),
      answer([part("prt_2", 2, { text: "Two." })]),
    );

    const view = await show(api, { tick: "t1" });
    expect(
      screen
        .getByRole("switch", { name: "Follow the newest step" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await view.again("t2");

    expect(assigned.length).toBeGreaterThanOrEqual(2);
    expect(assigned.every((value) => value === 1234)).toBe(true);
  });

  // #745-T80
  it("leaves the view alone when it is off, and moves it to the end when it is turned on", async () => {
    const assigned = scrollSpy();
    const { api } = apiAnswering(
      answer([part("prt_1", 1, { text: "One." })]),
      answer([part("prt_2", 2, { text: "Two." })]),
    );
    const view = await show(api, { tick: "t1" });
    fireEvent.click(
      screen.getByRole("switch", { name: "Follow the newest step" }),
    );
    assigned.length = 0;

    await view.again("t2");
    expect(assigned).toEqual([]);

    fireEvent.click(
      screen.getByRole("switch", { name: "Follow the newest step" }),
    );
    expect(assigned).toEqual([1234]);
  });

  // #745-T80
  it("starts off for a settled run that was opened later", async () => {
    const { api } = apiAnswering(answer(TURN));
    await show(api, { settled: true });

    fireEvent.click(
      screen.getByRole("button", { name: "Show what the agent did" }),
    );
    await act(async () => {});

    expect(
      screen
        .getByRole("switch", { name: "Follow the newest step" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});
