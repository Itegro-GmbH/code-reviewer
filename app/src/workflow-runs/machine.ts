// SPDX-License-Identifier: LicenseRef-Proprietary

// The state machine of a workflow run (#844), as a pure function: what the state of a run is, and the one move to make next. The engine
// (`engine.ts`) reads the state under the lock of the run, asks for the move, makes it, and asks again until the answer is `idle`. A
// move depends only on the state it is given, so a doubled or late event, which finds the state its first copy left, gets `idle`: that
// is what makes the engine idempotent.
//
// Version 1 of the engine runs the steps of the document one after the other, `agent` and `action` only. A run is `running` until the
// last step succeeded (`succeeded`) or a step failed or the budget ran out (`failed`).
import { MICRO_USD_PER_CENT } from "./limits.ts";
import type { RunFailureCode } from "./errors.ts";

export type MachineStep = {
  status: "pending" | "running" | "succeeded" | "failed";
  kind: "agent" | "action";
  /** An agent step has a job once its turn is queued. */
  hasJob: boolean;
  /** When the step was written. */
  createdAt: string;
  /** When the step was claimed; null for a step nobody has taken yet. */
  startedAt: string | null;
};

export type MachineState = {
  runStatus: "running" | "succeeded" | "failed";
  budgetMicroUsd: number;
  spentMicroUsd: number;
  /** The steps written so far, by position. */
  steps: readonly MachineStep[];
  /** The kinds of the steps of the pinned document, in order. */
  nodes: readonly string[];
  now: Date;
  /** A claimed step with no job is taken over after this long. */
  staleMs: number;
  /** A step that was written this long ago and still has no job is given up. */
  giveUpMs: number;
};

export type Move =
  /** Nothing to do now: the run is over, or it waits for a job that has not ended or a worker that holds a step. */
  | { move: "idle" }
  /** Write the next step; `capMicroUsd` is what an agent step may spend (the rest of the budget). */
  | {
      move: "add_step";
      position: number;
      kind: "agent" | "action";
      capMicroUsd: number | null;
    }
  /** Do what a step says. `takeOver`: its claimant did not finish. */
  | { move: "execute"; position: number; takeOver: boolean }
  /** The step's job may have ended: read it and end the step. */
  | { move: "read_job"; position: number }
  /** An action was started and the engine was interrupted (it is not repeated), or an agent step could not be started for too long. */
  | {
      move: "fail_step";
      position: number;
      code: "action_interrupted" | "agent_start_failed";
    }
  | {
      move: "finish_run";
      status: "succeeded" | "failed";
      errorCode: RunFailureCode | null;
    };

/** What is left of the budget, in micro dollars; zero when it is used up. */
export function remainingMicroUsd(
  state: Pick<MachineState, "budgetMicroUsd" | "spentMicroUsd">,
): number {
  return Math.max(0, state.budgetMicroUsd - state.spentMicroUsd);
}

function isStale(step: MachineStep, now: Date, staleMs: number): boolean {
  return step.startedAt !== null && age(step.startedAt, now) >= staleMs;
}

function age(since: string, now: Date): number {
  const at = Date.parse(since);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now.getTime() - at;
}

export function nextMove(state: MachineState): Move {
  if (state.runStatus !== "running") return { move: "idle" };

  const last = state.steps[state.steps.length - 1];
  if (last !== undefined) {
    const position = state.steps.length - 1;
    switch (last.status) {
      case "failed":
        return {
          move: "finish_run",
          status: "failed",
          errorCode: "step_failed",
        };
      case "pending":
        return { move: "execute", position, takeOver: false };
      case "running":
        if (last.kind === "agent" && last.hasJob)
          return { move: "read_job", position };
        // Claimed, nothing recorded yet: somebody is working on it, or they were interrupted.
        if (!isStale(last, state.now, state.staleMs)) return { move: "idle" };
        if (last.kind === "action")
          return { move: "fail_step", position, code: "action_interrupted" };
        if (age(last.createdAt, state.now) >= state.giveUpMs)
          return { move: "fail_step", position, code: "agent_start_failed" };
        // An agent step is started under a request id, so starting it again cannot start a second turn.
        return { move: "execute", position, takeOver: true };
      case "succeeded":
        break;
    }
  }

  const position = state.steps.length;
  const kind = state.nodes[position];
  if (kind === undefined)
    return { move: "finish_run", status: "succeeded", errorCode: null };
  if (kind !== "agent" && kind !== "action")
    return {
      move: "finish_run",
      status: "failed",
      errorCode: "step_kind_not_supported",
    };
  if (kind === "action")
    return { move: "add_step", position, kind, capMicroUsd: null };
  const remaining = remainingMicroUsd(state);
  // A task's cost limit is in whole cents: less than one cent cannot be handed out.
  if (remaining < MICRO_USD_PER_CENT)
    return {
      move: "finish_run",
      status: "failed",
      errorCode: "budget_exhausted",
    };
  return { move: "add_step", position, kind, capMicroUsd: remaining };
}
