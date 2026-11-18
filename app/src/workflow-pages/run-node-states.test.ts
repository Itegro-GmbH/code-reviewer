// SPDX-License-Identifier: LicenseRef-Proprietary

// The state of every node of a lane for one run (#1079): the whole tree (triggers with pre-steps, loops, if branches, onFailure), keyed by
// the id of the step, the latest round winning, and the step to select when nothing is asked for. The lane is the shipped "Issue to PR":
// triggers `labeled` and `manual` (with the pre-step `mark`), the shared steps `start`, the loop `fix` (`implement`, `review`), the `if`
// `done` (then `pr`, else `stuck`), and `onFailure` with `report` and `release`.
import { describe, expect, it } from "vitest";
import type { StepView } from "../workflow-runs/service.ts";
import { shippedLane } from "./builder/test-fixtures.ts";
import {
  nodeStatesOf,
  selectionOf,
  stateOfStatus,
  type NodeState,
} from "./run-node-states.ts";
import { run, step } from "./test-fixtures.ts";

function rows(
  ...specs: [string, StepView["status"], Partial<StepView>?][]
): StepView[] {
  const round = new Map<string, number>();
  return specs.map(([id, status, more], position) => {
    const next = (round.get(id) ?? 0) + 1;
    round.set(id, next);
    return step({
      id,
      position,
      status,
      round: next,
      kind: "agent",
      ...more,
    });
  });
}

function statesOf(
  steps: StepView[],
  more: Partial<Parameters<typeof run>[0]> = {},
) {
  const view = run({
    status: "running",
    trigger: "manual",
    triggerId: "manual",
    steps,
    ...more,
  });
  const states = nodeStatesOf(shippedLane(), view);
  if (states === undefined) throw new Error("the lane is readable");
  const state = (id: string): NodeState | undefined =>
    states.byStepId.get(id)?.state;
  return { states, state };
}

describe("the state of a row", () => {
  // #1079-T01
  it("maps every status of a step run to one of the node states", () => {
    expect(stateOfStatus("succeeded")).toBe("done");
    expect(stateOfStatus("running")).toBe("running");
    expect(stateOfStatus("pending")).toBe("running");
    expect(stateOfStatus("waiting")).toBe("waiting");
    expect(stateOfStatus("failed")).toBe("failed");
    expect(stateOfStatus("skipped")).toBe("skipped");
    // A status a newer server wrote is none of these.
    expect(stateOfStatus("expired" as StepView["status"])).toBe("notReached");
  });
});

describe("the states of the nodes of a lane", () => {
  // #1079-T02
  it("reaches every kind of node: triggers, pre-steps, shared steps, loop bodies, branches and onFailure", () => {
    const { states } = statesOf([]);
    expect([...states.byStepId.keys()].sort()).toEqual(
      [
        "labeled",
        "manual",
        "mark",
        "start",
        "fix",
        "implement",
        "review",
        "done",
        "pr",
        "stuck",
        "report",
        "release",
      ].sort(),
    );
  });

  // #1079-T03
  it("marks the trigger that started the run as done and the other triggers and their pre-steps as passed over", () => {
    const { state } = statesOf([], {
      triggerId: "labeled",
      trigger: "ticket.labeled",
    });
    expect(state("labeled")).toBe("done");
    expect(state("manual")).toBe("skipped");
    expect(state("mark")).toBe("skipped");
    expect(state("start")).toBe("notReached");
  });

  // #1079-T03
  it("finds the trigger of a run written before triggers had ids by its kind, the old label name included", () => {
    const { state } = statesOf([], {
      triggerId: null,
      trigger: "github.issueLabeled",
    });
    expect(state("labeled")).toBe("done");
    expect(state("manual")).toBe("skipped");
  });

  // #1079-T03
  it("marks neither of two triggers of one kind as unused when an old run does not say which fired", () => {
    const lane = {
      triggers: [
        { id: "first", kind: "manual", steps: [] },
        {
          id: "second",
          kind: "manual",
          steps: [{ id: "pre", kind: "action" }],
        },
      ],
      steps: [{ id: "only", kind: "action" }],
    };
    const states = nodeStatesOf(
      lane,
      run({
        triggerId: null,
        trigger: "manual",
        steps: rows(["only", "succeeded"]),
      }),
    );
    expect(states?.byStepId.get("first")?.state).toBe("notReached");
    expect(states?.byStepId.get("second")?.state).toBe("notReached");
    expect(states?.byStepId.get("pre")?.state).toBe("notReached");
    expect(states?.byStepId.get("only")?.state).toBe("done");
  });

  // #1079-T03
  it("passes over no trigger when the run does not say which started it", () => {
    const { state } = statesOf([], { triggerId: null, trigger: "schedule" });
    expect(state("labeled")).toBe("notReached");
    expect(state("mark")).toBe("notReached");
  });

  // #1079-T04
  it("gives a node that ran the state of its row and a node the run did not reach 'not reached'", () => {
    const { state } = statesOf(
      rows(["mark", "succeeded"], ["start", "succeeded"], ["fix", "running"]),
    );
    expect(state("mark")).toBe("done");
    expect(state("start")).toBe("done");
    expect(state("done")).toBe("notReached");
    expect(state("release")).toBe("notReached");
  });

  // #1079-T05
  it("lets the latest round win on a node of a loop body and keeps the earlier rounds", () => {
    const { states, state } = statesOf(
      rows(
        ["implement", "succeeded"],
        ["review", "failed", { errorCode: "no_result" }],
        ["implement", "running"],
      ),
    );
    expect(state("implement")).toBe("running");
    expect(
      states.byStepId.get("implement")?.rows.map((row) => row.round),
    ).toEqual([1, 2]);
    expect(states.byStepId.get("implement")?.latest?.round).toBe(2);
    expect(state("review")).toBe("failed");
  });

  // #1079-T06
  it("takes the state of a loop that runs from its body and tells the round it is in and the most it may run", () => {
    const { states, state } = statesOf(
      rows(
        ["implement", "succeeded"],
        ["review", "succeeded"],
        ["implement", "running"],
      ),
    );
    expect(state("fix")).toBe("running");
    expect(states.byStepId.get("fix")?.round).toBe(2);
    expect(states.byStepId.get("fix")?.maxRounds).toBe(3);
  });

  // #1079-T06
  it("shows a loop that has not started as not reached, without a round", () => {
    const { states } = statesOf([]);
    expect(states.byStepId.get("fix")?.state).toBe("notReached");
    expect(states.byStepId.get("fix")?.round).toBeUndefined();
  });

  // #1079-T06
  it("shows a loop whose body waits for an answer as waiting, and one whose step failed as failed", () => {
    expect(statesOf(rows(["implement", "waiting"])).state("fix")).toBe(
      "waiting",
    );
    expect(statesOf(rows(["implement", "failed"])).state("fix")).toBe("failed");
  });

  // #1079-T06
  it("takes the state and the rounds of a loop that has ended from its own row", () => {
    const { states, state } = statesOf(
      rows(
        ["implement", "succeeded"],
        ["review", "succeeded"],
        [
          "fix",
          "succeeded",
          { kind: "loop", output: { exit: "until", rounds: 1 } },
        ],
      ),
    );
    expect(state("fix")).toBe("done");
    expect(states.byStepId.get("fix")?.round).toBe(1);
  });

  // #1079-T07
  it("marks the branch an if did not take as skipped, and the one it took by its own rows", () => {
    const { state } = statesOf(
      rows(
        ["done", "succeeded", { kind: "if", output: { taken: "then" } }],
        ["stuck", "skipped", { kind: "action" }],
        ["pr", "running", { kind: "action" }],
      ),
    );
    expect(state("done")).toBe("done");
    expect(state("stuck")).toBe("skipped");
    expect(state("pr")).toBe("running");
  });

  // #1079-T07
  it("marks a loop inside a branch that was passed over as skipped", () => {
    const lane = {
      triggers: [{ id: "manual", kind: "manual", steps: [] }],
      steps: [
        {
          id: "gate",
          kind: "if",
          then: [],
          else: [
            {
              id: "again",
              kind: "loop",
              maxRounds: 2,
              body: [{ id: "inner", kind: "action" }],
            },
          ],
        },
      ],
    };
    const view = run({
      status: "running",
      triggerId: "manual",
      steps: rows(
        ["gate", "succeeded", { kind: "if", output: { taken: "then" } }],
        ["inner", "skipped", { kind: "action" }],
      ),
    });
    const states = nodeStatesOf(lane, view);
    expect(states?.byStepId.get("again")?.state).toBe("skipped");
    expect(states?.byStepId.get("inner")?.state).toBe("skipped");
  });

  // #1079-T08
  it("reads the steps of onFailure like the others", () => {
    const { state } = statesOf(
      rows(
        ["start", "failed", { kind: "action" }],
        ["report", "succeeded", { kind: "action" }],
      ),
      { status: "failed" },
    );
    expect(state("start")).toBe("failed");
    expect(state("report")).toBe("done");
    expect(state("release")).toBe("notReached");
  });

  // #1079-T09
  it("reads a lane with the single trigger of the format before triggers had ids", () => {
    const lane = {
      trigger: { kind: "manual" },
      steps: [{ id: "only", kind: "action" }],
    };
    const states = nodeStatesOf(
      lane,
      run({
        triggerId: null,
        trigger: "manual",
        steps: rows(["only", "succeeded"]),
      }),
    );
    expect(states?.byStepId.get("only")?.state).toBe("done");
    expect(states?.byStepId.get("manual")?.state).toBe("done");
  });

  // #1079-T10
  it("gives nothing for a document that is not a lane, and ignores nodes without an id or a known kind", () => {
    expect(nodeStatesOf("nope", run())).toBeUndefined();
    expect(nodeStatesOf(null, run())).toBeUndefined();
    const states = nodeStatesOf(
      {
        triggers: [],
        steps: [
          { kind: "agent" },
          { id: "x", kind: "teleport" },
          { id: "ok", kind: "action" },
        ],
      },
      run({ steps: [] }),
    );
    expect([...(states?.byStepId.keys() ?? [])]).toEqual(["ok"]);
  });
});

describe("the step to select", () => {
  // #1079-T11
  it("prefers the step that runs now, then the failed one, then the last one", () => {
    const running = statesOf(
      rows(["start", "succeeded"], ["implement", "running"]),
    ).states;
    expect(running.current).toBe("implement");
    expect(running.fallback).toBe("implement");

    const failed = statesOf(
      rows(
        ["start", "succeeded"],
        ["implement", "failed"],
        ["report", "succeeded"],
      ),
      { status: "failed" },
    ).states;
    expect(failed.current).toBeUndefined();
    expect(failed.failed).toBe("implement");
    expect(failed.fallback).toBe("implement");

    const done = statesOf(rows(["start", "succeeded"], ["pr", "succeeded"]), {
      status: "succeeded",
    }).states;
    expect(done.fallback).toBe("pr");
  });

  // #1079-T11
  it("does not take a step that was passed over as the last one", () => {
    const { states } = statesOf(
      rows(
        ["start", "succeeded"],
        ["done", "succeeded", { kind: "if", output: { taken: "then" } }],
        ["pr", "succeeded", { kind: "action" }],
        ["stuck", "skipped", { kind: "action" }],
      ),
      { status: "succeeded" },
    );
    expect(states.last).toBe("pr");
    expect(states.fallback).toBe("pr");
    // Nothing but passed-over rows: the newest of them is still better than nothing.
    expect(
      statesOf(rows(["stuck", "skipped", { kind: "action" }])).states.last,
    ).toBe("stuck");
  });

  // #1079-T11
  it("takes the one that waits for an answer as the current one, and the newest when several are open", () => {
    const waiting = statesOf(
      rows(["start", "succeeded"], ["implement", "waiting"]),
      {
        status: "waiting",
      },
    ).states;
    expect(waiting.current).toBe("implement");
    const two = statesOf(
      rows(["implement", "running"], ["review", "pending"]),
    ).states;
    expect(two.current).toBe("review");
  });

  // #1079-T11
  it("starts at the first step of the lane when the run has no row yet", () => {
    expect(statesOf([]).states.fallback).toBe("mark");
  });

  // #1079-T11
  it("ignores rows of a step the lane does not have", () => {
    const { states } = statesOf(
      rows(["start", "succeeded"], ["ghost", "running"]),
    );
    expect(states.current).toBeUndefined();
    expect(states.fallback).toBe("start");
  });

  // #1079-T12
  it("takes the step the address names when the lane has it, and the default for anything else", () => {
    const { states } = statesOf(
      rows(["start", "succeeded"], ["implement", "running"]),
    );
    expect(selectionOf(states, "start")).toBe("start");
    expect(selectionOf(states, "labeled")).toBe("labeled");
    expect(selectionOf(states, "nope")).toBe("implement");
    expect(selectionOf(states, "__proto__")).toBe("implement");
    expect(selectionOf(states, null)).toBe("implement");
    expect(selectionOf(states, undefined)).toBe("implement");
  });
});

// A loop in a loop (`LOOP_NESTING_MAX = 2`): the engine counts the rounds of a step over the whole run, so the round of a loop is
// counted per pass of the loop it is in, and a loop whose body is newer than its own end row is not over.
describe("loops in loops", () => {
  const nested = {
    triggers: [{ id: "manual", kind: "manual", steps: [] }],
    steps: [
      {
        id: "outer",
        kind: "loop",
        maxRounds: 3,
        body: [
          {
            id: "inner",
            kind: "loop",
            maxRounds: 3,
            body: [{ id: "x", kind: "agent" }],
          },
        ],
      },
    ],
  };
  const end = (
    rounds: number,
  ): [string, StepView["status"], Partial<StepView>] => [
    "inner",
    "succeeded",
    { kind: "loop", output: { exit: "until", rounds } },
  ];
  function nestedStates(
    steps: StepView[],
    more: Partial<Parameters<typeof run>[0]> = {},
  ) {
    const states = nodeStatesOf(
      nested,
      run({ status: "running", triggerId: "manual", steps, ...more }),
    );
    if (states === undefined) throw new Error("the lane is readable");
    return states.byStepId;
  }

  // #1079-T12
  it("counts the round of each loop per pass: x runs in round 2 of the outer loop after the inner loop ran three rounds in round 1", () => {
    const byStepId = nestedStates(
      rows(["x", "succeeded"], ["x", "succeeded"], ["x", "succeeded"], end(3), [
        "x",
        "running",
      ]),
    );
    expect(byStepId.get("x")?.state).toBe("running");
    expect(byStepId.get("inner")?.state).toBe("running");
    expect(byStepId.get("inner")?.round).toBe(1);
    expect(byStepId.get("inner")?.latest).toBeUndefined();
    expect(byStepId.get("outer")?.state).toBe("running");
    expect(byStepId.get("outer")?.round).toBe(2);
    expect(byStepId.get("outer")?.maxRounds).toBe(3);
  });

  // #1079-T12
  it("follows the round of the inner loop while it goes on inside one round of the outer loop", () => {
    const byStepId = nestedStates(
      rows(
        ["x", "succeeded"],
        end(1),
        ["x", "succeeded"],
        ["x", "succeeded"],
        ["x", "running"],
      ),
    );
    expect(byStepId.get("inner")?.round).toBe(3);
    expect(byStepId.get("outer")?.round).toBe(2);
  });

  // #1079-T12
  it("shows both loops as done with the rounds they ended with once everything is over", () => {
    const byStepId = nestedStates(
      rows(
        ["x", "succeeded"],
        end(1),
        ["x", "succeeded"],
        ["x", "succeeded"],
        end(2),
        [
          "outer",
          "succeeded",
          { kind: "loop", output: { exit: "until", rounds: 2 } },
        ],
      ),
      { status: "succeeded" },
    );
    expect(byStepId.get("inner")?.state).toBe("done");
    expect(byStepId.get("inner")?.round).toBe(2);
    expect(byStepId.get("outer")?.state).toBe("done");
    expect(byStepId.get("outer")?.round).toBe(2);
  });

  // #1079-T12
  it("shows both loops as failed when x fails inside the second round of the outer loop", () => {
    const byStepId = nestedStates(
      rows(["x", "succeeded"], end(1), [
        "x",
        "failed",
        { errorCode: "no_result" },
      ]),
      { status: "failed" },
    );
    expect(byStepId.get("x")?.state).toBe("failed");
    expect(byStepId.get("inner")?.state).toBe("failed");
    expect(byStepId.get("inner")?.round).toBe(1);
    expect(byStepId.get("outer")?.state).toBe("failed");
    expect(byStepId.get("outer")?.round).toBe(2);
  });

  // #1079-T12
  it("shows a loop that waits for an answer inside the second outer round as waiting", () => {
    const byStepId = nestedStates(
      rows(["x", "succeeded"], end(1), ["x", "waiting"]),
      { status: "waiting" },
    );
    expect(byStepId.get("inner")?.state).toBe("waiting");
    expect(byStepId.get("outer")?.state).toBe("waiting");
    expect(byStepId.get("outer")?.round).toBe(2);
  });
});
