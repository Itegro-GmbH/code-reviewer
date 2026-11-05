// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: the state machine of a run, as a table of states and the one move each gets.
import { describe, expect, it } from "vitest";
import {
  nextMove,
  remainingMicroUsd,
  type MachineState,
  type MachineStep,
} from "./machine.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const at = (secondsAgo: number): string =>
  new Date(NOW.getTime() - secondsAgo * 1000).toISOString();

function step(patch: Partial<MachineStep> = {}): MachineStep {
  return {
    status: "succeeded",
    kind: "agent",
    hasJob: true,
    createdAt: at(600),
    startedAt: at(600),
    ...patch,
  };
}

function state(patch: Partial<MachineState> = {}): MachineState {
  return {
    runStatus: "running",
    budgetMicroUsd: 20_000_000,
    spentMicroUsd: 0,
    steps: [],
    nodes: ["agent", "agent", "action"],
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
      kind: "agent",
      capMicroUsd: 20_000_000,
    });
  });

  // #844-T02
  it("caps the next agent step with what is left of the budget", () => {
    expect(
      nextMove(state({ steps: [step()], spentMicroUsd: 7_500_000 })),
    ).toEqual({
      move: "add_step",
      position: 1,
      kind: "agent",
      capMicroUsd: 12_500_000,
    });
  });

  // #844-T03
  it("ends the run with budget_exhausted when not one cent is left for the next agent step", () => {
    expect(
      nextMove(state({ steps: [step()], spentMicroUsd: 19_995_000 })),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "budget_exhausted",
    });
    expect(
      nextMove(state({ steps: [step()], spentMicroUsd: 25_000_000 })),
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
          steps: [step(), step()],
          spentMicroUsd: 20_000_000,
        }),
      ),
    ).toEqual({
      move: "add_step",
      position: 2,
      kind: "action",
      capMicroUsd: null,
    });
  });

  // #844-T05
  it("executes a step that is written and not claimed", () => {
    expect(
      nextMove(
        state({
          steps: [step({ status: "pending", hasJob: false, startedAt: null })],
        }),
      ),
    ).toEqual({ move: "execute", position: 0, takeOver: false });
  });

  // #844-T06
  it("reads the job of a running agent step and waits for nothing else", () => {
    expect(nextMove(state({ steps: [step({ status: "running" })] }))).toEqual({
      move: "read_job",
      position: 0,
    });
  });

  // #844-T07
  it("leaves a step alone that was claimed a moment ago, and takes an agent step over once its claim is stale", () => {
    const fresh = step({ status: "running", hasJob: false, startedAt: at(5) });
    expect(nextMove(state({ steps: [fresh] }))).toEqual({ move: "idle" });
    const stale = step({
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
    const stale = step({
      kind: "action",
      status: "running",
      hasJob: false,
      startedAt: at(300),
    });
    expect(nextMove(state({ steps: [stale] }))).toEqual({
      move: "fail_step",
      position: 0,
      code: "action_interrupted",
    });
  });

  // #844-T09
  it("gives up an agent step that could not be started for an hour", () => {
    const old = step({
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
    expect(nextMove(state({ steps: [step({ status: "failed" })] }))).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "step_failed",
    });
    expect(nextMove(state({ nodes: ["agent"], steps: [step()] }))).toEqual({
      move: "finish_run",
      status: "succeeded",
      errorCode: null,
    });
  });

  // #844-T11
  it("refuses a step kind it does not run", () => {
    expect(
      nextMove(state({ nodes: ["agent", "loop"], steps: [step()] })),
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
        nextMove(state({ runStatus, steps: [step({ status: "running" })] })),
      ).toEqual({ move: "idle" });
  });

  // #844-T13
  it("is a function of the state: the same state gives the same move, and a finished step moves on", () => {
    const waiting = state({ steps: [step({ status: "running" })] });
    expect(nextMove(waiting)).toEqual(nextMove({ ...waiting }));
    expect(
      nextMove(state({ steps: [step({ status: "succeeded" })] })),
    ).toMatchObject({ move: "add_step", position: 1 });
  });

  it("counts what is left of a budget that is overspent as nothing", () => {
    expect(remainingMicroUsd({ budgetMicroUsd: 10, spentMicroUsd: 12 })).toBe(
      0,
    );
  });
});
