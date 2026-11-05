// SPDX-License-Identifier: LicenseRef-Proprietary

// #844, #846: the state machine of a run, as a table of states and the one move each gets: the steps one after the other, and the
// control steps `if` and `loop` that the machine replays from the rows (rounds, `until`, `maxRounds`, the budget between two rounds,
// `previous`, the steps a branch skips).
import { describe, expect, it } from "vitest";
import {
  nextMove,
  remainingMicroUsd,
  replay,
  type MachineNode,
  type MachineState,
  type MachineStep,
  type RoundContext,
} from "./machine.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const at = (secondsAgo: number): string =>
  new Date(NOW.getTime() - secondsAgo * 1000).toISOString();

const agent = (id: string): MachineNode => ({ kind: "agent", id });
const action = (id: string): MachineNode => ({ kind: "action", id });
const branch = (
  id: string,
  then: MachineNode[],
  otherwise: MachineNode[] = [],
): MachineNode => ({ kind: "if", id, then, else: otherwise });
const loop = (
  id: string,
  maxRounds: number,
  body: MachineNode[],
): MachineNode => ({ kind: "loop", id, maxRounds, body });

function step(stepId: string, patch: Partial<MachineStep> = {}): MachineStep {
  return {
    stepId,
    status: "succeeded",
    kind: "agent",
    hasJob: true,
    createdAt: at(600),
    startedAt: at(600),
    ...patch,
  };
}

const done = (stepId: string, kind: MachineStep["kind"] = "agent") =>
  step(stepId, { kind, hasJob: kind === "agent" });
const decided = (
  stepId: string,
  kind: "if" | "loop",
  patch: Partial<MachineStep> = {},
) => step(stepId, { kind, hasJob: false, ...patch });
const skipped = (stepId: string, kind: MachineStep["kind"] = "action") =>
  step(stepId, { kind, status: "skipped", hasJob: false });

function state(patch: Partial<MachineState> = {}): MachineState {
  return {
    runStatus: "running",
    budgetMicroUsd: 20_000_000,
    spentMicroUsd: 0,
    steps: [],
    nodes: [agent("plan"), agent("build"), action("open")],
    holds: () => {
      throw new Error("no condition is asked in this test");
    },
    now: NOW,
    staleMs: 120_000,
    giveUpMs: 3_600_000,
    ...patch,
  };
}

describe("the state machine of a workflow run", () => {
  // #844-T01
  it("writes the first step with the whole budget as its cap", () => {
    expect(nextMove(state())).toEqual({
      move: "add_step",
      position: 0,
      stepId: "plan",
      kind: "agent",
      round: 1,
      capMicroUsd: 20_000_000,
    });
  });

  // #844-T02
  it("caps the next agent step with what is left of the budget", () => {
    expect(
      nextMove(state({ steps: [done("plan")], spentMicroUsd: 7_500_000 })),
    ).toEqual({
      move: "add_step",
      position: 1,
      stepId: "build",
      kind: "agent",
      round: 1,
      capMicroUsd: 12_500_000,
    });
  });

  // #844-T03
  it("ends the run with budget_exhausted when not one cent is left for the next agent step", () => {
    expect(
      nextMove(state({ steps: [done("plan")], spentMicroUsd: 19_995_000 })),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "budget_exhausted",
    });
    expect(
      nextMove(state({ steps: [done("plan")], spentMicroUsd: 25_000_000 })),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "budget_exhausted",
    });
  });

  // #844-T04
  it("still runs an action when the budget is used up: it costs nothing", () => {
    expect(
      nextMove(
        state({
          steps: [done("plan"), done("build")],
          spentMicroUsd: 20_000_000,
        }),
      ),
    ).toEqual({
      move: "add_step",
      position: 2,
      stepId: "open",
      kind: "action",
      round: 1,
      capMicroUsd: null,
    });
  });

  // #844-T05
  it("executes a step that is written and not claimed", () => {
    expect(
      nextMove(
        state({
          steps: [
            step("plan", {
              status: "pending",
              hasJob: false,
              startedAt: null,
            }),
          ],
        }),
      ),
    ).toEqual({ move: "execute", position: 0, takeOver: false });
  });

  // #844-T06
  it("reads the job of a running agent step and waits for nothing else", () => {
    expect(
      nextMove(state({ steps: [step("plan", { status: "running" })] })),
    ).toEqual({
      move: "read_job",
      position: 0,
    });
  });

  // #844-T07
  it("leaves a step alone that was claimed a moment ago, and takes an agent step over once its claim is stale", () => {
    const fresh = step("plan", {
      status: "running",
      hasJob: false,
      startedAt: at(5),
    });
    expect(nextMove(state({ steps: [fresh] }))).toEqual({ move: "idle" });
    const stale = step("plan", {
      status: "running",
      hasJob: false,
      startedAt: at(300),
    });
    expect(nextMove(state({ steps: [stale] }))).toEqual({
      move: "execute",
      position: 0,
      takeOver: true,
    });
  });

  // #844-T08
  it("never repeats an action that was started: a stale one fails as interrupted", () => {
    const stale = step("open", {
      kind: "action",
      status: "running",
      hasJob: false,
      startedAt: at(300),
    });
    expect(
      nextMove(state({ nodes: [action("open")], steps: [stale] })),
    ).toEqual({
      move: "fail_step",
      position: 0,
      code: "action_interrupted",
    });
  });

  // #844-T09
  it("gives up an agent step that could not be started for an hour", () => {
    const old = step("plan", {
      status: "running",
      hasJob: false,
      createdAt: at(4000),
      startedAt: at(300),
    });
    expect(nextMove(state({ steps: [old] }))).toEqual({
      move: "fail_step",
      position: 0,
      code: "agent_start_failed",
    });
  });

  // #844-T10
  it("fails the run when a step failed, and succeeds it after the last step", () => {
    expect(
      nextMove(state({ steps: [step("plan", { status: "failed" })] })),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "step_failed",
    });
    expect(
      nextMove(state({ nodes: [agent("plan")], steps: [done("plan")] })),
    ).toEqual({
      move: "finish_run",
      status: "succeeded",
      errorCode: null,
    });
  });

  // #844-T11
  it("refuses a node it does not run", () => {
    expect(
      nextMove(
        state({
          nodes: [agent("plan"), { kind: "unsupported", id: "later" }],
          steps: [done("plan")],
        }),
      ),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "step_kind_not_supported",
    });
  });

  // #844-T12
  it("does nothing for a run that is over, however its steps look", () => {
    for (const runStatus of ["succeeded", "failed"] as const)
      expect(
        nextMove(
          state({ runStatus, steps: [step("plan", { status: "running" })] }),
        ),
      ).toEqual({ move: "idle" });
  });

  // #844-T13
  it("is a function of the state: the same state gives the same move, and a finished step moves on", () => {
    const waiting = state({ steps: [step("plan", { status: "running" })] });
    expect(nextMove(waiting)).toEqual(nextMove({ ...waiting }));
    expect(nextMove(state({ steps: [done("plan")] }))).toMatchObject({
      move: "add_step",
      position: 1,
    });
  });

  it("counts what is left of a budget that is overspent as nothing", () => {
    expect(remainingMicroUsd({ budgetMicroUsd: 10, spentMicroUsd: 12 })).toBe(
      0,
    );
  });
});

describe("an if", () => {
  const nodes = [
    branch(
      "done",
      [action("pr")],
      [action("stuck"), branch("inner", [action("a")], [action("b")])],
    ),
  ];

  // #846-T01
  it("takes the then branch when the condition holds, and writes the steps of the other as skipped", () => {
    expect(nextMove(state({ nodes, holds: () => true }))).toEqual({
      move: "add_if",
      position: 0,
      stepId: "done",
      round: 1,
      taken: "then",
      skipped: [
        { stepId: "stuck", kind: "action", round: 1 },
        { stepId: "inner", kind: "if", round: 1 },
        { stepId: "a", kind: "action", round: 1 },
        { stepId: "b", kind: "action", round: 1 },
      ],
    });
  });

  // #846-T02
  it("takes the else branch when it does not, and an if without an else skips nothing when it holds", () => {
    expect(nextMove(state({ nodes, holds: () => false }))).toMatchObject({
      move: "add_if",
      taken: "else",
      skipped: [{ stepId: "pr", kind: "action", round: 1 }],
    });
    expect(
      nextMove(
        state({
          nodes: [branch("only", [action("pr")])],
          holds: () => true,
        }),
      ),
    ).toMatchObject({ move: "add_if", taken: "then", skipped: [] });
  });

  // #846-T03
  it("goes on in the branch it took once its row and the skipped rows are there", () => {
    const steps = [
      decided("done", "if", { taken: "then" }),
      skipped("stuck"),
      skipped("inner", "if"),
      skipped("a"),
      skipped("b"),
    ];
    expect(nextMove(state({ nodes, steps }))).toMatchObject({
      move: "add_step",
      position: 5,
      stepId: "pr",
      kind: "action",
    });
    expect(
      nextMove(state({ nodes, steps: [...steps, done("pr", "action")] })),
    ).toEqual({ move: "finish_run", status: "succeeded", errorCode: null });
  });

  // #846-T04
  it("asks the condition of the node it decides, with the steps of the round before in reach", () => {
    const asked: string[] = [];
    nextMove(
      state({
        nodes,
        holds: (id) => {
          asked.push(id);
          return true;
        },
      }),
    );
    expect(asked).toEqual(["done"]);
  });

  // #846-T05
  it("ends the run with condition_failed when the condition cannot be told", () => {
    expect(
      nextMove(
        state({
          nodes,
          holds: () => {
            throw new Error("a value is missing");
          },
        }),
      ),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "condition_failed",
    });
  });

  // #846-T06
  it("ends the run with document_unusable when the rows are not what the document says", () => {
    expect(
      nextMove(state({ nodes, steps: [decided("done", "if")] })),
    ).toMatchObject({ move: "finish_run", errorCode: "document_unusable" });
    expect(
      nextMove(
        state({
          nodes,
          steps: [decided("done", "if", { taken: "then" }), skipped("other")],
        }),
      ),
    ).toMatchObject({ move: "finish_run", errorCode: "document_unusable" });
    expect(
      nextMove(state({ nodes, steps: [done("elsewhere", "action")] })),
    ).toMatchObject({ move: "finish_run", errorCode: "document_unusable" });
  });
});

describe("a loop", () => {
  const fix = loop("fix", 3, [agent("implement"), agent("review")]);
  const nodes = [action("start"), fix, action("after")];
  const start = done("start", "action");
  /** The rows of `n` rounds of the loop after `start`. */
  const rounds = (n: number): MachineStep[] =>
    Array.from({ length: n }, () => [done("implement"), done("review")]).flat();

  // #846-T10
  it("writes the first step of the body in round one, with the step's own round", () => {
    expect(nextMove(state({ nodes, steps: [start] }))).toEqual({
      move: "add_step",
      position: 1,
      stepId: "implement",
      kind: "agent",
      round: 1,
      capMicroUsd: 20_000_000,
    });
    expect(
      nextMove(state({ nodes, steps: [start, done("implement")] })),
    ).toMatchObject({
      move: "add_step",
      position: 2,
      stepId: "review",
      round: 1,
    });
  });

  // #846-T11
  it("runs the body again when until does not hold: the same steps, one round later", () => {
    expect(
      nextMove(
        state({ nodes, steps: [start, ...rounds(1)], holds: () => false }),
      ),
    ).toEqual({
      move: "add_step",
      position: 3,
      stepId: "implement",
      kind: "agent",
      round: 2,
      capMicroUsd: 20_000_000,
    });
    expect(
      nextMove(
        state({ nodes, steps: [start, ...rounds(2)], holds: () => false }),
      ),
    ).toMatchObject({ stepId: "implement", round: 3 });
  });

  // #846-T12
  it("ends the loop with until, and until wins over maxRounds in the last round", () => {
    expect(
      nextMove(
        state({ nodes, steps: [start, ...rounds(1)], holds: () => true }),
      ),
    ).toEqual({
      move: "end_loop",
      position: 3,
      stepId: "fix",
      round: 1,
      exit: "until",
      rounds: 1,
    });
    expect(
      nextMove(
        state({ nodes, steps: [start, ...rounds(3)], holds: () => true }),
      ),
    ).toMatchObject({ move: "end_loop", exit: "until", rounds: 3 });
  });

  // #846-T13
  it("ends the loop with maxRounds after the last allowed round", () => {
    expect(
      nextMove(
        state({ nodes, steps: [start, ...rounds(3)], holds: () => false }),
      ),
    ).toMatchObject({
      move: "end_loop",
      position: 7,
      exit: "maxRounds",
      rounds: 3,
    });
  });

  // #846-T14
  it("ends the loop with budget when the budget cannot pay another agent step, only between two rounds", () => {
    expect(
      nextMove(
        state({
          nodes,
          steps: [start, ...rounds(1)],
          spentMicroUsd: 19_995_000,
          holds: () => false,
        }),
      ),
    ).toMatchObject({ move: "end_loop", exit: "budget", rounds: 1 });
    // Inside a round the budget is not asked for the loop, but for the next agent step, as everywhere.
    expect(
      nextMove(
        state({
          nodes,
          steps: [start, done("implement")],
          spentMicroUsd: 19_995_000,
        }),
      ),
    ).toMatchObject({ move: "finish_run", errorCode: "budget_exhausted" });
  });

  // #846-T15
  it("goes on after the row of the loop, and caps an agent step of a later round with what is left of the budget over all rounds", () => {
    const ended = decided("fix", "loop");
    expect(
      nextMove(state({ nodes, steps: [start, ...rounds(2), ended] })),
    ).toMatchObject({ move: "add_step", position: 6, stepId: "after" });
    expect(
      nextMove(
        state({
          nodes,
          steps: [start, ...rounds(2)],
          spentMicroUsd: 12_000_000,
          holds: () => false,
        }),
      ),
    ).toMatchObject({ stepId: "implement", round: 3, capMicroUsd: 8_000_000 });
  });

  // #846-T16
  it("asks until with the round that just ended in reach as previous", () => {
    const seen: RoundContext[] = [];
    nextMove(
      state({
        nodes,
        steps: [start, ...rounds(2)],
        holds: (_id, context) => {
          seen.push(context);
          return true;
        },
      }),
    );
    expect(seen).toEqual([
      {
        loopId: "fix",
        loopRound: 2,
        // implement and review of round one are the rows 1 and 2.
        previous: { implement: 1, review: 2 },
      },
    ]);
  });

  // #846-T20
  it("points previous in round three at the rows of round two, not at those of round one", () => {
    const steps = [
      start,
      ...rounds(2),
      done("implement"),
      step("review", { status: "pending", hasJob: false }),
    ];

    const { contexts } = replay(nodes, steps);

    // Rows: start 0, round one 1-2, round two 3-4, round three 5-6.
    expect(contexts[1]).toMatchObject({ loopRound: 1, previous: {} });
    expect(contexts[3]).toMatchObject({
      loopRound: 2,
      previous: { implement: 1, review: 2 },
    });
    expect(contexts[5]).toMatchObject({
      loopRound: 3,
      previous: { implement: 3, review: 4 },
    });
    expect(contexts[6]).toMatchObject({
      loopRound: 3,
      previous: { implement: 3, review: 4 },
    });
  });

  // #846-T17
  it("ends the run with condition_failed when until cannot be told", () => {
    expect(
      nextMove(
        state({
          nodes,
          steps: [start, ...rounds(1)],
          holds: () => {
            throw new Error("a value is missing");
          },
        }),
      ),
    ).toMatchObject({ move: "finish_run", errorCode: "condition_failed" });
  });

  // #846-T18
  it("takes a step that is not over before the loop's decision: the rest of the body waits for it", () => {
    expect(
      nextMove(
        state({
          nodes,
          steps: [
            start,
            done("implement"),
            step("review", { status: "running" }),
          ],
        }),
      ),
    ).toEqual({ move: "read_job", position: 2 });
  });

  // #846-T19
  it("refuses rows with more rounds than the loop allows", () => {
    expect(
      nextMove(state({ nodes, steps: [start, ...rounds(4)] })),
    ).toMatchObject({ move: "finish_run", errorCode: "document_unusable" });
  });
});

describe("what the replay tells about a row", () => {
  const body = [agent("implement"), agent("review")];
  const nodes = [
    loop("fix", 3, [
      ...body,
      branch("note", [action("say")], [action("quiet")]),
    ]),
  ];
  const round = (taken: "then" | "else"): MachineStep[] => [
    done("implement"),
    done("review"),
    decided("note", "if", { taken }),
    ...(taken === "then" ? [skipped("quiet")] : [skipped("say")]),
    done(taken === "then" ? "say" : "quiet", "action"),
  ];

  // #846-T30
  it("gives each row its loop, its round and the rows of the round before", () => {
    const steps = [...round("then"), ...round("else")];
    const { contexts, stop } = replay(nodes, steps);

    expect(stop).toMatchObject({ kind: "decide_loop", rounds: 2 });
    expect(contexts[0]).toEqual({ loopId: "fix", loopRound: 1, previous: {} });
    // Round two: implement, review and note of round one are the rows 0, 1 and 2.
    expect(contexts[5]).toEqual({
      loopId: "fix",
      loopRound: 2,
      previous: { implement: 0, review: 1, note: 2 },
    });
    expect(contexts[9]).toMatchObject({ loopRound: 2 });
  });

  // #846-T31
  it("counts a step's rounds across the rounds of an outer loop, so a step never has the same round twice", () => {
    const nested = [
      loop("outer", 2, [loop("inner", 2, [agent("work")]), action("note")]),
    ];
    const afterInner = [done("work"), decided("inner", "loop")];
    expect(
      nextMove(state({ nodes: nested, steps: afterInner, holds: () => false })),
    ).toMatchObject({ stepId: "note", kind: "action", round: 1 });
    expect(
      nextMove(
        state({
          nodes: nested,
          steps: [...afterInner, done("note", "action")],
          holds: () => false,
        }),
      ),
    ).toMatchObject({ stepId: "work", round: 2, position: 3 });
    expect(
      nextMove(
        state({
          nodes: nested,
          steps: [
            ...afterInner,
            done("note", "action"),
            done("work"),
            decided("inner", "loop", {}),
          ],
          holds: () => false,
        }),
      ),
    ).toMatchObject({ stepId: "note", round: 2 });
  });

  // #846-T32
  it("writes a step that an if skipped in an earlier round as skipped again in the next, with its own round", () => {
    const steps = round("then");
    expect(nextMove(state({ nodes, steps, holds: () => false }))).toMatchObject(
      { stepId: "implement", round: 2 },
    );
    const second = [...steps, done("implement"), done("review")];
    expect(
      nextMove(state({ nodes, steps: second, holds: () => false })),
    ).toMatchObject({
      move: "add_if",
      taken: "else",
      round: 2,
      skipped: [{ stepId: "say", kind: "action", round: 2 }],
    });
  });
});
