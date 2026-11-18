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
  ...extra,
});
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
      node("loop", "loop", { innerIds: ["code", "test"] }),
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
