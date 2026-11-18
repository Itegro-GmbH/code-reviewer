// SPDX-License-Identifier: LicenseRef-Proprietary

// The step rows of a run laid onto the top-level nodes of its lane (#1078): states, loops, if/else with an untaken branch, the current
// step and the text alternative.
import { describe, expect, it } from "vitest";
import type { LaneNodeView } from "../workflow-runs/lane-nodes.ts";
import {
  trackDescription,
  trackOf,
  trackStepTitle,
  type TrackStepRow,
} from "./run-track.ts";

const node = (
  id: string,
  kind: LaneNodeView["kind"],
  extra: Partial<LaneNodeView> = {},
): LaneNodeView => ({
  id,
  kind,
  note: null,
  connector: null,
  innerIds: [],
  body: [],
  ...extra,
});
const child = (
  id: string,
  kind: LaneNodeView["kind"] = "agent",
  innerIds: string[] = [],
) => ({ id, kind, innerIds });
const row = (
  id: string,
  status: string,
  extra: Partial<TrackStepRow> = {},
): TrackStepRow => ({ id, kind: "agent", status, round: 1, ...extra });

const flat = [
  node("plan", "agent", { note: "Plan" }),
  node("build", "agent", { note: "Build" }),
  node("review", "agent", { note: "Review" }),
  node("merge", "action", { connector: "pr.merge" }),
];

const states = (track: ReturnType<typeof trackOf>) =>
  track.steps.map((step) => step.state);

describe("trackOf", () => {
  // #1078-T10
  it("marks what ran as done, the running step as running and the rest as not reached", () => {
    const track = trackOf(
      flat,
      [row("plan", "succeeded"), row("build", "running")],
      "running",
    );

    expect(states(track)).toEqual([
      "done",
      "running",
      "not_reached",
      "not_reached",
    ]);
    expect(track.current).toBe(1);
  });

  // #1078-T11
  it("treats a queued (pending) step as running", () => {
    const track = trackOf(flat, [row("plan", "pending")], "running");

    expect(states(track)[0]).toBe("running");
  });

  // #1078-T12
  it("marks a step that waits for an answer, and makes it the current one", () => {
    const track = trackOf(
      flat,
      [row("plan", "succeeded"), row("build", "waiting")],
      "waiting",
    );

    expect(states(track)).toEqual([
      "done",
      "waiting",
      "not_reached",
      "not_reached",
    ]);
    expect(track.current).toBe(1);
  });

  // #1078-T13
  it("marks the failed step and leaves the steps after it not reached", () => {
    const track = trackOf(
      flat,
      [row("plan", "succeeded"), row("build", "failed")],
      "failed",
    );

    expect(states(track)).toEqual([
      "done",
      "failed",
      "not_reached",
      "not_reached",
    ]);
    expect(track.current).toBe(1);
  });

  // #1078-T14
  it("points at the last step reached once the run has ended", () => {
    const track = trackOf(
      flat,
      [
        row("plan", "succeeded"),
        row("build", "succeeded"),
        row("review", "succeeded"),
        row("merge", "succeeded", { kind: "action" }),
      ],
      "succeeded",
    );

    expect(states(track)).toEqual(["done", "done", "done", "done"]);
    expect(track.current).toBe(3);
  });

  // #1078-T15
  it("marks a step that was written off as skipped (a run that was stopped first)", () => {
    const track = trackOf(
      flat,
      [row("plan", "succeeded"), row("build", "skipped")],
      "cancelled",
    );

    expect(states(track)).toEqual([
      "done",
      "skipped",
      "not_reached",
      "not_reached",
    ]);
  });

  // #1078-T16
  it("has no current step before any step is written", () => {
    const track = trackOf(flat, [], "running");

    expect(states(track)).toEqual([
      "not_reached",
      "not_reached",
      "not_reached",
      "not_reached",
    ]);
    expect(track.current).toBeNull();
  });

  // #1078-T17
  it("ignores rows that belong to no node, such as the steps of onFailure", () => {
    const track = trackOf(
      flat,
      [row("plan", "failed"), row("cleanup", "succeeded")],
      "failed",
    );

    expect(states(track)).toEqual([
      "failed",
      "not_reached",
      "not_reached",
      "not_reached",
    ]);
  });

  describe("if and else", () => {
    const lane = [
      node("start", "agent"),
      node("check", "if", { innerIds: ["fix", "wrap"] }),
      node("finish", "action"),
    ];

    // #1078-T18
    it("counts the branch that was not taken as not reached: its skipped rows do not colour the if", () => {
      const track = trackOf(
        lane,
        [
          row("start", "succeeded"),
          row("check", "succeeded", { kind: "if" }),
          row("fix", "skipped"),
          row("wrap", "succeeded", { kind: "action" }),
          row("finish", "succeeded", { kind: "action" }),
        ],
        "succeeded",
      );

      expect(states(track)).toEqual(["done", "done", "done"]);
    });

    // #1078-T19
    it("is done when the if took a branch and both branches' rows are skipped or succeeded", () => {
      const track = trackOf(
        lane,
        [
          row("start", "succeeded"),
          row("check", "succeeded", { kind: "if" }),
          row("fix", "skipped"),
          row("wrap", "skipped", { kind: "action" }),
        ],
        "failed",
      );

      expect(states(track)).toEqual(["done", "done", "not_reached"]);
    });

    // #1078-T20
    it("shows the if as running while a step of the branch it took runs", () => {
      const track = trackOf(
        lane,
        [
          row("start", "succeeded"),
          row("check", "succeeded", { kind: "if" }),
          row("fix", "running"),
          row("wrap", "skipped", { kind: "action" }),
        ],
        "running",
      );

      expect(states(track)).toEqual(["done", "running", "not_reached"]);
      expect(track.current).toBe(1);
    });

    // #1078-T21
    it("shows the last node reached as running between two steps, when it is an if of an active run", () => {
      const track = trackOf(
        lane,
        [row("start", "succeeded"), row("check", "succeeded", { kind: "if" })],
        "running",
      );

      expect(states(track)).toEqual(["done", "running", "not_reached"]);
    });
  });

  describe("loop", () => {
    const lane = [
      node("loop", "loop", {
        innerIds: ["code", "test"],
        body: [child("code"), child("test", "action")],
      }),
      node("ship", "action"),
    ];

    // #1078-T22
    it("is running while its body runs, with the number of rounds so far", () => {
      const track = trackOf(
        lane,
        [
          row("code", "succeeded"),
          row("test", "succeeded", { kind: "action" }),
          row("code", "running", { round: 2 }),
        ],
        "running",
      );

      expect(states(track)).toEqual(["running", "not_reached"]);
      expect(track.steps[0]?.rounds).toBe(2);
    });

    // #1078-T23
    it("is running between two rounds, until its own row says it decided", () => {
      const between = trackOf(
        lane,
        [
          row("code", "succeeded"),
          row("test", "succeeded", { kind: "action" }),
        ],
        "running",
      );
      const decided = trackOf(
        lane,
        [
          row("code", "succeeded"),
          row("test", "succeeded", { kind: "action" }),
          row("loop", "succeeded", { kind: "loop" }),
        ],
        "running",
      );

      expect(states(between)[0]).toBe("running");
      expect(states(decided)[0]).toBe("done");
    });

    // #1078-T24
    it("is failed when a step in its body failed", () => {
      const track = trackOf(lane, [row("code", "failed")], "failed");

      expect(states(track)).toEqual(["failed", "not_reached"]);
    });
  });

  // A step row counts over the whole run (the engine's `roundOf`), so the rounds of a loop are read from its direct body only.
  describe("a loop in a loop", () => {
    // outer (max 2) { inner (max 3) { s } }: `s` runs 1..3 in the first round of outer and 4..6 in the second.
    const lane = [
      node("outer", "loop", {
        innerIds: ["inner", "s"],
        body: [child("inner", "loop", ["s"])],
      }),
      node("ship", "action"),
    ];
    const s = (round: number, status = "succeeded") =>
      row("s", status, { round });
    const inner = () => row("inner", "succeeded", { kind: "loop" });
    const firstRound = [s(1), s(2), s(3), inner()];
    const secondRound = [s(4), s(5), s(6), inner()];

    // #1078-T40
    it("counts the rounds of the outer loop, not the runs of the step inside the inner one", () => {
      const rounds = (rows: TrackStepRow[]) =>
        trackOf(lane, rows, "running").steps[0]?.rounds;

      expect(rounds([s(1, "running")])).toBe(1);
      expect(rounds([s(1), s(2), s(3, "running")])).toBe(1);
      // the inner loop has ended once and nothing of the next round has begun: still round 1
      expect(rounds(firstRound)).toBe(1);
      // `s` is at its fourth run, which is the second round of outer, not a fourth round
      expect(rounds([...firstRound, s(4, "running")])).toBe(2);
      expect(rounds([...firstRound, s(4), s(5)])).toBe(2);
      expect(rounds([...firstRound, ...secondRound])).toBe(2);
    });

    // #1078-T41
    it("stays within the maximum of the outer loop when the run is over", () => {
      const track = trackOf(
        lane,
        [
          ...firstRound,
          ...secondRound,
          row("outer", "succeeded", { kind: "loop" }),
          row("ship", "succeeded", { kind: "action" }),
        ],
        "succeeded",
      );

      expect(track.steps[0]?.rounds).toBe(2);
      expect(states(track)).toEqual(["done", "done"]);
    });

    // #1078-T42
    it("is running while the body runs, and between the rounds of the inner loop", () => {
      expect(
        states(trackOf(lane, [...firstRound, s(4, "running")], "running")),
      ).toEqual(["running", "not_reached"]);
      expect(states(trackOf(lane, firstRound, "running"))).toEqual([
        "running",
        "not_reached",
      ]);
    });

    // #1078-T43
    it("gives 1 round for a loop that has not started and for any node that is no loop", () => {
      const track = trackOf(lane, [], "running");

      expect(track.steps.map((step) => step.rounds)).toEqual([1, 1]);
    });
  });

  // #1078-T44
  describe("an if in a loop body", () => {
    const lane = [
      node("loop", "loop", {
        innerIds: ["check", "fix", "wrap", "test"],
        body: [child("check", "if", ["fix", "wrap"]), child("test", "action")],
      }),
    ];

    it("counts the rounds when the if takes the other branch in round 2, and is not coloured by the skipped branch", () => {
      const rows = [
        row("check", "succeeded", { kind: "if" }),
        row("fix", "succeeded"),
        row("wrap", "skipped", { kind: "action" }),
        row("test", "succeeded", { kind: "action" }),
        row("check", "succeeded", { kind: "if", round: 2 }),
        row("fix", "skipped", { round: 2 }),
        row("wrap", "running", { kind: "action", round: 2 }),
      ];
      const running = trackOf(lane, rows, "running");
      const ended = trackOf(
        lane,
        [
          ...rows.slice(0, 6),
          row("wrap", "succeeded", { kind: "action", round: 2 }),
          row("test", "succeeded", { kind: "action", round: 2 }),
          row("loop", "succeeded", { kind: "loop" }),
        ],
        "succeeded",
      );

      expect(running.steps[0]?.rounds).toBe(2);
      expect(states(running)).toEqual(["running"]);
      expect(ended.steps[0]?.rounds).toBe(2);
      expect(states(ended)).toEqual(["done"]);
    });

    it("gives a top-level if with a loop in its branch one round, however often the loop went round", () => {
      const branch = [node("check", "if", { innerIds: ["again", "work"] })];
      const track = trackOf(
        branch,
        [
          row("check", "succeeded", { kind: "if" }),
          row("work", "succeeded"),
          row("work", "succeeded", { round: 2 }),
          row("work", "succeeded", { round: 3 }),
          row("again", "succeeded", { kind: "loop" }),
        ],
        "succeeded",
      );

      expect(track.steps[0]?.rounds).toBe(1);
    });
  });
});

describe("the failure phase", () => {
  const lane = [
    node("start", "agent"),
    node("check", "if", { innerIds: ["fix"] }),
    node("loop", "loop", {
      innerIds: ["code"],
      body: [child("code")],
    }),
    node("ship", "action"),
  ];

  // #1078-T45
  it("leaves the rows of the onFailure steps out and does not keep an if or a loop of a failed run running", () => {
    const track = trackOf(
      lane,
      [
        row("start", "succeeded"),
        row("check", "succeeded", { kind: "if" }),
        row("fix", "succeeded"),
        row("code", "succeeded"),
        row("code", "succeeded", { round: 2 }),
        row("notify", "succeeded", { kind: "action" }),
      ],
      "failed",
    );

    // `notify` belongs to no node; the loop was left by the failure and no body step runs
    expect(states(track)).toEqual(["done", "done", "done", "not_reached"]);
    expect(track.steps).toHaveLength(4);
    expect(track.current).toBe(2);
  });

  // #1078-T46
  it("shows the step that failed, and the steps after it as not reached, with onFailure rows after it", () => {
    const track = trackOf(
      lane,
      [
        row("start", "succeeded"),
        row("check", "succeeded", { kind: "if" }),
        row("fix", "failed"),
        row("notify", "succeeded", { kind: "action" }),
      ],
      "failed",
    );

    expect(states(track)).toEqual([
      "done",
      "failed",
      "not_reached",
      "not_reached",
    ]);
    expect(track.current).toBe(1);
  });
});

describe("a run of an older version of the lane", () => {
  // #1078-T47
  it("ignores the rows of steps the version has no node for", () => {
    const lane = [node("plan", "agent"), node("build", "agent")];

    const track = trackOf(
      lane,
      [
        row("old-plan", "succeeded"),
        row("old-build", "running"),
        row("old-loop", "succeeded", { kind: "loop", round: 3 }),
      ],
      "running",
    );

    expect(states(track)).toEqual(["not_reached", "not_reached"]);
    expect(track.steps.map((step) => step.rounds)).toEqual([1, 1]);
    expect(track.current).toBeNull();
    expect(trackDescription(track)).toBe("No step has started yet");
  });

  // #1078-T48
  it("lays on the rows it has a node for and leaves the others out", () => {
    const lane = [node("plan", "agent"), node("build", "agent")];

    const track = trackOf(
      lane,
      [
        row("plan", "succeeded"),
        row("gone", "succeeded"),
        row("build", "running"),
      ],
      "running",
    );

    expect(states(track)).toEqual(["done", "running"]);
  });
});

describe("trackStepTitle", () => {
  // #1078-T30
  it("names a step by its note, else its connector, else its kind", () => {
    expect(trackStepTitle(node("a", "agent", { note: "Plan" }))).toBe("Plan");
    expect(trackStepTitle(node("a", "action", { connector: "pr.merge" }))).toBe(
      "pr.merge",
    );
    expect(trackStepTitle(node("a", "agent"))).toBe("Agent step");
    expect(trackStepTitle(node("a", "if"))).toBe("Condition");
    expect(trackStepTitle(node("a", "loop"))).toBe("Repeat");
  });
});

describe("trackDescription", () => {
  // #1078-T31
  it("reads like 'Step 2 of 4: Review, running'", () => {
    const lane = [
      node("a", "agent", { note: "Plan" }),
      node("b", "agent", { note: "Review" }),
      node("c", "agent"),
      node("d", "agent"),
    ];
    const track = trackOf(
      lane,
      [row("a", "succeeded"), row("b", "running")],
      "running",
    );

    expect(trackDescription(track)).toBe("Step 2 of 4: Review, running");
  });

  // #1078-T32
  it("says so when no step has started or the lane cannot be read", () => {
    expect(trackDescription(trackOf(flat, [], "running"))).toBe(
      "No step has started yet",
    );
    expect(trackDescription(trackOf([], [], "running"))).toBe(
      "The steps of this lane version are not available",
    );
  });

  // #1078-T33
  it("uses the words of a state that waits for an answer", () => {
    const track = trackOf(flat, [row("plan", "waiting")], "waiting");

    expect(trackDescription(track)).toBe(
      "Step 1 of 4: Plan, waiting for an answer",
    );
  });
});
