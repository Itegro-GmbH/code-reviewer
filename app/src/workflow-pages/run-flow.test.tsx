// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The run page as the lane's flow (#1079): the shipped lane drawn with where the run stands on every node, the step that is selected
// (the current one by default, the one the address names), the panel of that step (labelled, with its rounds, its question and the agent's
// run), `?step=` in the address after a click, a sheet on a narrow screen, and the plain list when the lane cannot be drawn.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunsApi } from "../runs/ui/api.ts";
import type { McpCallsSnapshot } from "../runs/mcp-calls-view.ts";
import type { RunView, StepView } from "../workflow-runs/service.ts";
import type { WorkflowRunsApi } from "./api.ts";
import { setAt } from "./builder/document.ts";
import { shippedLane } from "./builder/test-fixtures.ts";
import { WorkflowRunDetail } from "./run-detail.tsx";
import { JOB_ID, run, step } from "./test-fixtures.ts";

// The address is read from the window, as the router would hand it over.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function rows(
  ...specs: [string, StepView["status"], Partial<StepView>?][]
): StepView[] {
  const count = new Map<string, number>();
  return specs.map(([id, status, more], position) => {
    const round = (count.get(id) ?? 0) + 1;
    count.set(id, round);
    return step({
      id,
      position,
      status,
      round,
      kind: "action",
      jobId: null,
      turnId: null,
      costUsd: null,
      costBasis: null,
      output: null,
      finishedAt: status === "running" ? null : "2026-11-05T10:02:06.000Z",
      ...more,
    });
  });
}

const NO_CALLS: McpCallsSnapshot = {
  calls: [],
  cursor: 0,
  hasMore: false,
  full: false,
  omitted: 0,
};
const noCalls = (): RunsApi =>
  ({
    mcpCalls: vi.fn(async () => ({ ok: true as const, data: NO_CALLS })),
  }) as unknown as RunsApi;

function show(
  steps: StepView[],
  over: Partial<RunView> = {},
  props: {
    document?: unknown;
    api?: WorkflowRunsApi;
    runsApi?: RunsApi;
  } = {},
) {
  const view = render(
    <WorkflowRunDetail
      workspaceSlug="acme"
      workflowId="wf-1"
      laneName="Issue to PR"
      initial={{
        run: run({
          triggerId: "manual",
          status: "running",
          steps,
          ...over,
        }),
      }}
      document={"document" in props ? props.document : shippedLane()}
      api={props.api ?? ({ run: vi.fn() } as unknown as WorkflowRunsApi)}
      runsApi={props.runsApi ?? noCalls()}
    />,
  );
  const node = (id: string) =>
    view.container.querySelector(`[data-node-step="${id}"]`) as HTMLElement;
  const panel = () =>
    view.container.querySelector("[data-slot=step-panel]") as HTMLElement;
  return { ...view, node, panel };
}

const MIDWAY = (): StepView[] =>
  rows(
    ["mark", "succeeded"],
    ["start", "succeeded"],
    ["implement", "succeeded", { kind: "agent" }],
    ["review", "succeeded", { kind: "agent" }],
    ["implement", "running", { kind: "agent" }],
  );

describe("the lane as a flow with the state of the run on each node", () => {
  // #1079-T16
  it("draws every node of the lane as a button with its state in a word, and the round of the loop", () => {
    const { node, container } = show(MIDWAY());

    expect(container.querySelector("[data-slot=run-flow]")).toBeTruthy();
    // Every node is a button, which a keyboard reaches.
    expect(node("implement").tagName).toBe("BUTTON");
    expect(node("manual").tagName).toBe("BUTTON");
    expect(node("start").getAttribute("data-state")).toBe("done");
    expect(node("implement").getAttribute("data-state")).toBe("running");
    expect(node("done").getAttribute("data-state")).toBe("notReached");
    expect(within(node("start")).getByText("Done")).toBeTruthy();
    expect(within(node("implement")).getByText("Running")).toBeTruthy();
    expect(within(node("done")).getByText("Not reached")).toBeTruthy();
    // The trigger that started the run, and the one that did not.
    expect(within(node("manual")).getByText("Started this run")).toBeTruthy();
    expect(
      within(node("labeled")).getByText("Not used in this run"),
    ).toBeTruthy();
    // The loop is in its second round.
    expect(within(node("fix")).getByText(/Round 2 of max 3/)).toBeTruthy();
  });

  // #1079-T16
  it("draws the loop as a container around its body, the branches of an if side by side, and onFailure at the bottom", () => {
    const { container, node } = show(MIDWAY());
    const loop = container.querySelector(
      "[data-container=loop]",
    ) as HTMLElement;
    expect(loop.contains(node("implement"))).toBe(true);
    expect(loop.contains(node("review"))).toBe(true);
    const branch = container.querySelector(
      "[data-container=if]",
    ) as HTMLElement;
    expect(
      branch.querySelector("[data-branch=then] [data-node-step=pr]"),
    ).toBeTruthy();
    expect(
      branch.querySelector("[data-branch=else] [data-node-step=stuck]"),
    ).toBeTruthy();
    const failure = container.querySelector(
      "[data-group=onFailure]",
    ) as HTMLElement;
    expect(failure.contains(node("report"))).toBe(true);
  });

  // #1079-T17
  it("marks the step that runs now as the current one, and the running symbol pulses only when motion is welcome", () => {
    const { node } = show(MIDWAY());
    expect(node("implement").getAttribute("aria-current")).toBe("step");
    expect(within(node("implement")).getByText("Current step")).toBeTruthy();
    expect(node("review").getAttribute("aria-current")).toBeNull();
    const symbol = node("implement").querySelector(
      "[data-slot=node-state] svg",
    );
    expect(symbol?.getAttribute("class")).toContain(
      "motion-safe:animate-pulse",
    );
    // Every animation of the node is behind `motion-safe`, so none runs for a person who asked for less motion.
    const classes = [...node("implement").querySelectorAll("[class*=animate]")]
      .map((element) => element.getAttribute("class") ?? "")
      .flatMap((value) => value.split(/\s+/))
      .filter((name) => name.includes("animate-"));
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.every((name) => name.startsWith("motion-safe:"))).toBe(true);
  });

  // #1079-T17
  it("scrolls the current step into view once, when the page opens", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { node } = show(MIDWAY());
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(node("implement"));
    // @ts-expect-error: jsdom has none, the stub was only for this test
    delete Element.prototype.scrollIntoView;
  });

  // #1079-T18
  it("shows what a step cost and how long it took on its node, where that is known", () => {
    const { node } = show(
      rows(
        ["mark", "succeeded"],
        [
          "start",
          "succeeded",
          {
            costUsd: 0.42,
            costBasis: "reported",
            startedAt: "2026-11-05T10:00:00.000Z",
            finishedAt: "2026-11-05T10:02:05.000Z",
          },
        ],
      ),
    );
    const facts = node("start").querySelector("[data-slot=node-facts]");
    expect(facts?.textContent).toContain("$0.42");
    expect(facts?.textContent).toMatch(/2 min/);
    expect(
      node("mark").querySelector("[data-slot=node-facts]")?.textContent,
    ).toMatch(/2 min/);
    expect(node("done").querySelector("[data-slot=node-facts]")).toBeNull();
  });
});

describe("the step that is selected", () => {
  // #1079-T19
  it("is the current step, with its panel named by its heading", () => {
    const { node, panel } = show(MIDWAY());
    const aside = screen.getByRole("complementary");
    expect(aside.getAttribute("aria-labelledby")).toBeTruthy();
    expect(
      within(aside).getByRole("heading", { name: "implement" }),
    ).toBeTruthy();
    expect(panel().getAttribute("data-step")).toBe("implement");
    expect(node("implement").getAttribute("aria-pressed")).toBe("true");
    expect(node("review").getAttribute("aria-pressed")).toBe("false");
  });

  // #1079-T19
  it("is the failed step when none runs, and says why it failed in words", () => {
    const { panel } = show(
      rows(
        ["mark", "succeeded"],
        ["start", "failed", { errorCode: "action_failed" }],
        ["report", "succeeded"],
      ),
      { status: "failed" },
    );
    expect(panel().getAttribute("data-step")).toBe("start");
    expect(panel().querySelector("[data-slot=step-failure]")?.textContent).toBe(
      "The action failed.",
    );
  });

  // #1079-T19
  it("is the last step when the run is over and nothing failed", () => {
    const { panel } = show(
      rows(["mark", "succeeded"], ["start", "succeeded"]),
      {
        status: "succeeded",
      },
    );
    expect(panel().getAttribute("data-step")).toBe("start");
  });

  // #1079-T20
  it("changes to the node that is clicked, and puts ?step in the address without a new entry in the history", () => {
    const length = window.history.length;
    const { node, panel } = show(MIDWAY());
    fireEvent.click(node("review"));
    expect(panel().getAttribute("data-step")).toBe("review");
    expect(node("review").getAttribute("aria-pressed")).toBe("true");
    expect(node("implement").getAttribute("aria-pressed")).toBe("false");
    expect(window.location.search).toBe("?step=review");
    expect(window.history.length).toBe(length);
    fireEvent.click(node("done"));
    expect(window.location.search).toBe("?step=done");
  });

  // #1079-T20
  it("opens on the step the address names, and ignores a name the lane does not have", () => {
    window.history.replaceState(null, "", "/?step=start");
    const named = show(MIDWAY());
    expect(named.panel().getAttribute("data-step")).toBe("start");
    named.unmount();

    window.history.replaceState(null, "", "/?step=%3Cimg%20src%3Dx%3E");
    const unknown = show(MIDWAY());
    expect(unknown.panel().getAttribute("data-step")).toBe("implement");
    expect(unknown.container.querySelector("img")).toBeNull();
  });

  // #1079-T20
  it("keeps the person's choice while the run goes on, and follows the run until there is one", () => {
    const followed = show(MIDWAY());
    expect(followed.panel().getAttribute("data-step")).toBe("implement");
    followed.unmount();
    const chosen = show(MIDWAY());
    fireEvent.click(chosen.node("mark"));
    expect(chosen.panel().getAttribute("data-step")).toBe("mark");
  });
});

describe("what the panel tells about a step", () => {
  // #1079-T21
  it("tells a step that was not reached in a sentence, without a result or a cost", () => {
    const { node, panel } = show(MIDWAY());
    fireEvent.click(node("pr"));
    expect(panel().textContent).toContain("The run has not got to this step.");
    expect(panel().querySelector("[data-slot=step-result]")).toBeNull();
    fireEvent.click(node("labeled"));
    expect(panel().textContent).toContain("skipped");
  });

  // #1079-T21
  it("gives the facts of a step that ran: status, times, duration, cost with its basis, profile", () => {
    const { node, panel } = show(
      rows(
        ["mark", "succeeded"],
        [
          "implement",
          "succeeded",
          {
            kind: "agent",
            costUsd: 0.42,
            costBasis: "estimated",
            profile: { name: "implementer", version: 2 },
            startedAt: "2026-11-05T10:00:00.000Z",
            finishedAt: "2026-11-05T10:03:00.000Z",
          },
        ],
      ),
    );
    fireEvent.click(node("implement"));
    const text = panel().textContent ?? "";
    expect(text).toContain("Succeeded");
    expect(text).toContain("implementer version 2");
    expect(
      panel().querySelector("[data-slot=step-duration]")?.textContent,
    ).toBe("3 min 00 s");
    expect(panel().querySelector("[data-slot=step-cost]")?.textContent).toBe(
      "$0.42",
    );
    expect(
      panel()
        .querySelector("[data-slot=cost-basis]")
        ?.getAttribute("data-basis"),
    ).toBe("estimated");
  });

  // #1079-T22
  it("shows what the agent said first, as text, then its branch and the rest of its fields", () => {
    const hostile = '<img src=x onerror="alert(1)">Cached <b>it</b>';
    const { container, panel } = show(
      rows(
        ["start", "succeeded"],
        [
          "implement",
          "succeeded",
          {
            kind: "agent",
            jobId: JOB_ID,
            output: {
              summary: hostile,
              branch: "workflow/run-1/implement",
              extra: 1,
            },
          },
        ],
      ),
    );
    const result = panel().querySelector(
      "[data-slot=step-result]",
    ) as HTMLElement;
    expect(
      result.querySelector("[data-slot=step-agent-summary]")?.textContent,
    ).toBe(hostile);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    const order = [...result.querySelectorAll("p, details")].map(
      (element) =>
        element.getAttribute("data-slot") ?? element.tagName.toLowerCase(),
    );
    expect(order[0]).toBe("step-agent-summary");
    expect(result.textContent).toContain("workflow/run-1/implement");
    expect(result.querySelector("pre")?.textContent).toContain('"extra": 1');
    expect(result.querySelector("pre")?.textContent).not.toContain("summary");
  });

  // #1079-T23
  it("lists every round of a step, the earlier ones with their result in a block that opens on request", () => {
    const { node, panel } = show(MIDWAY());
    const rounds = panel().querySelectorAll("[data-slot=step-round]");
    expect(
      [...rounds].map((entry) => entry.getAttribute("data-round")),
    ).toEqual(["2", "1"]);
    expect(rounds[0]?.querySelector("details")).toBeNull();
    expect(rounds[1]?.querySelector("details")).toBeTruthy();
    // The loop that holds the step tells the round it is in.
    fireEvent.click(node("fix"));
    expect(panel().textContent).toContain("Round 2 of max 3");
  });

  // #1079-T23
  it("lists no rounds for a step that ran once", () => {
    const { node, panel } = show(MIDWAY());
    fireEvent.click(node("start"));
    expect(panel().querySelector("[data-slot=step-rounds]")).toBeNull();
  });

  // #1079-T24
  it("links the run of an agent step in the Implementer and shows the MCP calls of that job", async () => {
    const runsApi = {
      mcpCalls: vi.fn(async () => ({
        ok: true as const,
        data: {
          ...NO_CALLS,
          cursor: 1,
          calls: [
            {
              seq: 1,
              serverId: "11111111-1111-4111-8111-111111111111",
              serverName: "Linear <b>",
              rpcMethod: "tools/call",
              tool: "list_issues",
              status: 200,
              outcome: "ok" as const,
              result: "ok" as const,
              durationMs: 120,
              requestBytes: 1,
              responseBytes: 1,
              at: "2026-11-17T08:00:00.000Z",
            },
          ],
        },
      })),
    } as unknown as RunsApi;
    const { container, panel } = show(
      rows(
        ["start", "succeeded"],
        ["implement", "running", { kind: "agent", jobId: JOB_ID }],
      ),
      {},
      { runsApi },
    );
    expect(
      within(panel())
        .getByRole("link", { name: /agent's run/ })
        .getAttribute("href"),
    ).toBe(`/w/acme/runs/${JOB_ID}`);
    expect(await screen.findByText("Linear <b>")).toBeTruthy();
    expect(container.querySelector("[data-slot=run-mcp-call] b")).toBeNull();
    expect(runsApi.mcpCalls).toHaveBeenCalledWith(JOB_ID, 0);
  });

  // #1079-T24
  it("shows no run link and no MCP calls for an action, and none for an agent step that has no job yet", () => {
    const runsApi = noCalls();
    const { panel } = show(rows(["start", "running"]), {}, { runsApi });
    expect(within(panel()).queryByRole("link")).toBeNull();
    expect(runsApi.mcpCalls).not.toHaveBeenCalled();
  });

  // #1079-T25
  it("shows the question of a step that waits, with the way to answer, in its panel", () => {
    const { panel } = show(
      rows(
        ["start", "succeeded"],
        [
          "implement",
          "waiting",
          {
            kind: "agent",
            finishedAt: null,
            ask: {
              n: 1,
              state: "open",
              question: "Retry which failures? <b>now</b>",
              options: ["Network errors", "All of them"],
            },
          },
        ],
      ),
      { status: "waiting" },
    );
    expect(panel().getAttribute("data-step")).toBe("implement");
    expect(
      panel().querySelector("[data-slot=step-ask-question]")?.textContent,
    ).toBe("Retry which failures? <b>now</b>");
    expect(panel().querySelector("b")).toBeNull();
    expect(
      within(panel()).getByRole("button", { name: "Answer 2" }),
    ).toBeTruthy();
  });
});

describe("text from the lane document", () => {
  // #1079-T26
  it("is rendered as text: a note with markup is never an element", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const lane = setAt(shippedLane(), "/steps/0/description", hostile);
    const { container, node } = show(MIDWAY(), {}, { document: lane });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(node("start").textContent).toContain("<img src=x");
  });
});

describe("a lane that cannot be drawn", () => {
  // #1079-T27
  it("lists the steps as the page always did, when the lane is missing or is no lane", () => {
    for (const document of [undefined, null, "nope", 7]) {
      const view = show(MIDWAY(), {}, { document });
      expect(view.container.querySelector("[data-slot=run-flow]")).toBeNull();
      expect(
        view.container.querySelectorAll("[data-slot=run-step]"),
      ).toHaveLength(5);
      view.unmount();
    }
  });
});

describe("a narrow screen", () => {
  function narrow(matches: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  }

  // #1079-T28
  it("opens the panel as a sheet when a node is clicked, named by the step", async () => {
    narrow(true);
    const { node } = show(MIDWAY());
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      fireEvent.click(node("review"));
    });
    const dialog = screen.getByRole("dialog", { name: "review" });
    expect(
      dialog.querySelector("[data-slot=step-panel]")?.getAttribute("data-step"),
    ).toBe("review");
    expect(window.location.search).toBe("?step=review");
  });

  // #1079-T28
  it("keeps the panel beside the flow on a wide screen", () => {
    narrow(false);
    show(MIDWAY());
    expect(screen.getByRole("complementary")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the header of the run", () => {
  const ticket = {
    key: "15",
    number: 15,
    title: "Cache the <i>list</i>",
    url: "https://github.com/acme/widgets/issues/15",
    repo: { fullName: "acme/widgets" },
  };

  // #1079-T29
  it("tells the ticket (ref, title as text, link), the lane and its version, the trigger, the actor and how long it took", () => {
    const { container } = show(MIDWAY(), {
      input: { ticket },
      trigger: "ticket.labeled",
      triggerId: "labeled",
      actorLogin: "octocat",
      status: "succeeded",
      finishedAt: "2026-11-05T10:05:00.000Z",
      workflowVersion: 3,
    });
    const line = container.querySelector(
      "[data-slot=run-ticket]",
    ) as HTMLElement;
    // The ref and the title, both as text (joined, so the ref is not read as a colour).
    expect(line.textContent).toBe(["#15", "Cache the <i>list</i>"].join(""));
    expect(line.querySelector("i")).toBeNull();
    expect(line.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/issues/15",
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Issue to PR");
    expect(text).toContain("A label on a ticket");
    expect(text).toContain("octocat");
    expect(
      container.querySelector("[data-slot=run-duration]")?.textContent,
    ).toBe("5 min 00 s");
    expect(container.querySelector("[data-slot=run-spent]")).toBeTruthy();
  });

  // #1079-T29
  it("links the ticket only when its address is the run's own repository on github.com", () => {
    const { container } = show(MIDWAY(), {
      input: {
        ticket: {
          ...ticket,
          url: "https://evil.example/acme/widgets/issues/15",
        },
      },
    });
    const line = container.querySelector(
      "[data-slot=run-ticket]",
    ) as HTMLElement;
    expect(line.querySelector("a")).toBeNull();
    expect(line.textContent).toContain("#15");
  });

  // #1079-T29
  it("shows no ticket line for a run with no ticket", () => {
    const { container } = show(MIDWAY());
    expect(container.querySelector("[data-slot=run-ticket]")).toBeNull();
  });
});
