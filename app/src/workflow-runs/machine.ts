// SPDX-License-Identifier: LicenseRef-Proprietary

// The state machine of a workflow run (#844, #846), as a pure function: what the state of a run is, and the one move to make next. The
// engine (`engine.ts`) reads the state under the lock of the run, asks for the move, makes it, and asks again until the answer is
// `idle`. A move depends only on the state it is given, so a doubled or late event, which finds the state its first copy left, gets
// `idle`: that is what makes the engine idempotent.
//
// The steps of a run are written in the order they run, one row each, and the document is a tree: `if` has two branches, `loop` a
// body that runs again and again. The machine does not keep a cursor. It REPLAYS the rows against the document (`replay`): each row is
// the next node the walk expects, a control step's row says what it decided, so the walk ends exactly where the run stands, and the move
// is what that place asks for. The replay is also how the engine learns, for a row, which round of its loop it belongs to and which
// rows of the round before `previous.<step>` means (`RoundContext`).
//
//  - A node of kind `agent` or `action` is one row, written `pending`; the run waits for it (`execute`, `read_job`) before the walk goes on.
//  - An `if` is one row, `succeeded`, whose output names the branch (`taken`), and one `skipped` row for every node of the other
//    branch, written in the same move. The walk then goes into the branch that was taken.
//  - A `loop` has no row of its own while it runs. After its body the walk looks at the next row: a row of the loop is its end, the
//    first row of the body is the next round, and no row yet means the loop has to decide: `until` holds (exit `until`), it was the
//    last round (`maxRounds`), or the budget cannot pay another agent step (`budget`: checked only between two rounds), else the
//    body starts again. The decision is written as the loop's row, with `exit` and `rounds` as its output.
//
// A run is `running` until the walk is over (`succeeded`), a step failed or the budget ran out (`failed`), or a member stopped it (`cancelled`, #891:
// once a stop is asked for, no step is written or started any more; a turn that runs is asked to stop, a step that did not start is
// skipped, and the run ends when nothing runs).
import { MICRO_USD_PER_CENT } from "./limits.ts";
import type { RunFailureCode } from "./errors.ts";

/** A node of the document as the machine walks it. `unsupported`: a kind the engine does not run, or a node that is not well formed. */
export type MachineNode =
  | { kind: "agent" | "action"; id: string }
  | {
      kind: "if";
      id: string;
      then: readonly MachineNode[];
      else: readonly MachineNode[];
    }
  | {
      kind: "loop";
      id: string;
      maxRounds: number;
      body: readonly MachineNode[];
    }
  | { kind: "unsupported"; id: string };

export type MachineStep = {
  stepId: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  kind: "agent" | "action" | "if" | "loop";
  /** An agent step has a job once its turn is queued. */
  hasJob: boolean;
  /** When the step was written. */
  createdAt: string;
  /** When the step was claimed; null for a step nobody has taken yet. */
  startedAt: string | null;
  /** Why a failed step failed (`cancelled` for a turn a member stopped, #891). */
  errorCode?: string | null;
  /** For an `if`: the branch it took. */
  taken?: "then" | "else";
};

/**
 * Where in its loop a step is. `previous` maps the id of each direct step of the body to the row it has in the round before (an index
 * into the steps), so that `previous.<step>.<field>` can be read from that row: empty in the first round and outside loops.
 */
export type RoundContext = {
  /** The innermost loop the step is in, or null. */
  loopId: string | null;
  /** The round of that loop, from 1 (1 outside loops). */
  loopRound: number;
  previous: Readonly<Record<string, number>>;
};

export type MachineState = {
  runStatus: "running" | "succeeded" | "failed" | "cancelled";
  /** A member asked for the run to stop (#891). */
  cancelRequested: boolean;
  budgetMicroUsd: number;
  spentMicroUsd: number;
  /** The steps written so far, by position. */
  steps: readonly MachineStep[];
  /** The nodes of the pinned document, in order. */
  nodes: readonly MachineNode[];
  /**
   * Whether the condition of the `if` (`when`) or the `loop` (`until`) with this id holds, with the steps of the round before in reach.
   * It may throw (a value the condition needs is missing): the run then ends with `condition_failed`.
   */
  holds(nodeId: string, context: RoundContext): boolean;
  now: Date;
  /** A claimed step with no job is taken over after this long. */
  staleMs: number;
  /** A step that was written this long ago and still has no job is given up. */
  giveUpMs: number;
};

/** A step the move writes in a branch that was not taken. */
export type SkippedStep = {
  stepId: string;
  kind: "agent" | "action" | "if" | "loop";
  round: number;
};

export type Move =
  /** Nothing to do now: the run is over, or it waits for a job that has not ended or a worker that holds a step. */
  | { move: "idle" }
  /** Write the next step; `capMicroUsd` is what an agent step may spend (the rest of the budget). */
  | {
      move: "add_step";
      position: number;
      stepId: string;
      kind: "agent" | "action";
      /** How often this step has run in the run, counting this time. */
      round: number;
      capMicroUsd: number | null;
    }
  /** An `if` decided: write it, and the steps of the branch it did not take as skipped. */
  | {
      move: "add_if";
      position: number;
      stepId: string;
      round: number;
      taken: "then" | "else";
      skipped: SkippedStep[];
    }
  /** A `loop` ends: write its row with `exit` and the number of `rounds` that ran. */
  | {
      move: "end_loop";
      position: number;
      stepId: string;
      round: number;
      exit: "until" | "maxRounds" | "budget";
      rounds: number;
    }
  /** Do what a step says. `takeOver`: its claimant did not finish. */
  | { move: "execute"; position: number; takeOver: boolean }
  /** The step's job may have ended: read it and end the step. */
  | { move: "read_job"; position: number }
  /** #891: a stop was asked for and the step's turn runs: ask its job to stop (asked again at every look, which is harmless). */
  | { move: "cancel_job"; position: number }
  /** #891: a stop was asked for and the step was written and not claimed: it ends skipped. */
  | { move: "skip_step"; position: number }
  /**
   * An action was started and the engine was interrupted (it is not repeated), an agent step could not be started for too long, or (#891) a
   * stop was asked for while an agent step had no turn yet.
   */
  | {
      move: "fail_step";
      position: number;
      code: "action_interrupted" | "agent_start_failed" | "cancelled";
    }
  | {
      move: "finish_run";
      status: "succeeded" | "failed" | "cancelled";
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

type LoopNode = Extract<MachineNode, { kind: "loop" }>;

/** Where the walk of the rows over the document stopped. */
type Stop =
  /** The next node to write: an `agent`, `action` or `if`. */
  | { kind: "add"; node: MachineNode; context: RoundContext }
  /** The body of a loop is over for this round and the loop has not been told to go on or end. */
  | {
      kind: "decide_loop";
      loop: LoopNode;
      rounds: number;
      /** The context of the loop's own row. */
      context: RoundContext;
      /** The round that just ended: what `until` can reach as `previous`. */
      finished: RoundContext;
      /** The walk of the next round. */
      again(): Stop | undefined;
    }
  /** The last row is a step that is not over. */
  | { kind: "open"; index: number }
  | { kind: "unsupported"; node: MachineNode }
  /** The rows are not what the document says they should be. */
  | { kind: "mismatch" };

export type Replayed = {
  /** Undefined: the whole document has run. */
  stop: Stop | undefined;
  /** The context of each row that was matched to a node, by row index. */
  contexts: (RoundContext | undefined)[];
};

/** Every node inside the list, at any depth, in the order they appear: what an untaken branch skips. */
function flatten(nodes: readonly MachineNode[]): MachineNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.kind === "if"
      ? flatten([...node.then, ...node.else])
      : node.kind === "loop"
        ? flatten(node.body)
        : []),
  ]);
}

/** Walks the rows over the nodes: see the top of this file. Pure. */
export function replay(
  nodes: readonly MachineNode[],
  steps: readonly MachineStep[],
): Replayed {
  let at = 0;
  const contexts: (RoundContext | undefined)[] = [];
  const mismatch: Stop = { kind: "mismatch" };

  /** Matches the row at `at` to a node that is written as one row and consumes it. */
  function consume(
    node: MachineNode,
    context: RoundContext,
    direct: Map<string, number> | null,
  ): MachineStep | undefined {
    const row = steps[at];
    if (row === undefined || row.stepId !== node.id || row.kind !== node.kind)
      return undefined;
    contexts[at] = context;
    direct?.set(node.id, at);
    at += 1;
    return row;
  }

  function walkList(
    list: readonly MachineNode[],
    context: RoundContext,
    direct: Map<string, number> | null,
  ): Stop | undefined {
    for (const node of list) {
      const stop = walkNode(node, context, direct);
      if (stop !== undefined) return stop;
    }
    return undefined;
  }

  function walkLoop(
    node: LoopNode,
    context: RoundContext,
    outer: Map<string, number> | null,
    startRound: number,
    startPrevious: Readonly<Record<string, number>>,
  ): Stop | undefined {
    let round = startRound;
    let previous = startPrevious;
    for (;;) {
      const direct = new Map<string, number>();
      const inner: RoundContext = {
        loopId: node.id,
        loopRound: round,
        previous,
      };
      const stop = walkList(node.body, inner, direct);
      if (stop !== undefined) return stop;
      // The body is over for this round. The next row says what happens next.
      const rows = Object.fromEntries(direct);
      const next = steps[at];
      if (next === undefined) {
        const ended = round;
        return {
          kind: "decide_loop",
          loop: node,
          rounds: ended,
          context,
          finished: inner,
          again: () => walkLoop(node, context, outer, ended + 1, rows),
        };
      }
      if (next.kind === "loop" && next.stepId === node.id) {
        const row = consume(node, context, outer);
        return row?.status === "succeeded" ? undefined : mismatch;
      }
      if (round >= node.maxRounds) return mismatch;
      round += 1;
      previous = rows;
    }
  }

  function walkNode(
    node: MachineNode,
    context: RoundContext,
    direct: Map<string, number> | null,
  ): Stop | undefined {
    switch (node.kind) {
      case "unsupported":
        return { kind: "unsupported", node };
      case "loop":
        return walkLoop(node, context, direct, 1, {});
      case "if": {
        if (steps[at] === undefined) return { kind: "add", node, context };
        const row = consume(node, context, direct);
        if (row?.status !== "succeeded" || row.taken === undefined)
          return mismatch;
        const [taken, untaken] =
          row.taken === "then"
            ? [node.then, node.else]
            : [node.else, node.then];
        for (const skipped of flatten(untaken)) {
          const next = steps[at];
          if (
            next?.stepId !== skipped.id ||
            next.kind !== skipped.kind ||
            next.status !== "skipped"
          )
            return mismatch;
          at += 1;
        }
        return walkList(taken, context, null);
      }
      case "agent":
      case "action": {
        if (steps[at] === undefined) return { kind: "add", node, context };
        const row = consume(node, context, direct);
        if (row === undefined) return mismatch;
        if (row.status === "succeeded") return undefined;
        // Only the last row can be a step that is not over.
        return at === steps.length && row.status !== "skipped"
          ? { kind: "open", index: at - 1 }
          : mismatch;
      }
    }
  }

  const root: RoundContext = { loopId: null, loopRound: 1, previous: {} };
  const stop = walkList(nodes, root, null);
  return { stop, contexts };
}

/** How often the step has run so far, plus this time. */
function roundOf(steps: readonly MachineStep[], stepId: string): number {
  return steps.filter((step) => step.stepId === stepId).length + 1;
}

/** What a run does once a member asked it to stop: nothing new starts, what runs is asked to stop, and the run ends when nothing runs. */
function cancelMove(state: MachineState): Move {
  const last = state.steps[state.steps.length - 1];
  if (last === undefined)
    return { move: "finish_run", status: "cancelled", errorCode: null };
  const position = state.steps.length - 1;
  switch (last.status) {
    case "pending":
      return { move: "skip_step", position };
    case "running":
      if (last.kind === "agent" && last.hasJob)
        return { move: "cancel_job", position };
      // An agent step whose turn is not recorded yet: the one that claimed it may be starting the turn this moment. The step ends now, the
      // turn that may exist under its request id is found and asked to stop (`fail_step`), and one that starts later is stopped by the one
      // that started it (`attachTurn` fails for an ended step).
      if (last.kind === "agent")
        return { move: "fail_step", position, code: "cancelled" };
      // An action that runs is not interrupted (it may have happened); one that was interrupted is told so, as in any run.
      return isStale(last, state.now, state.staleMs)
        ? { move: "fail_step", position, code: "action_interrupted" }
        : { move: "idle" };
    case "failed":
    case "succeeded":
    case "skipped":
      return { move: "finish_run", status: "cancelled", errorCode: null };
  }
}

export function nextMove(state: MachineState): Move {
  if (state.runStatus !== "running") return { move: "idle" };
  if (state.cancelRequested) return cancelMove(state);

  const last = state.steps[state.steps.length - 1];
  if (last !== undefined) {
    const position = state.steps.length - 1;
    switch (last.status) {
      case "failed":
        // #891: the turn of this step was stopped by a member (through the run, or through the task itself): the run is cancelled, not failed.
        if (last.errorCode === "cancelled")
          return { move: "finish_run", status: "cancelled", errorCode: null };
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
        if (last.kind !== "agent")
          return { move: "fail_step", position, code: "action_interrupted" };
        if (age(last.createdAt, state.now) >= state.giveUpMs)
          return { move: "fail_step", position, code: "agent_start_failed" };
        // An agent step is started under a request id, so starting it again cannot start a second turn.
        return { move: "execute", position, takeOver: true };
      case "succeeded":
      case "skipped":
        break;
    }
  }

  const { stop } = replay(state.nodes, state.steps);
  return moveFor(state, stop);
}

function moveFor(state: MachineState, stop: Stop | undefined): Move {
  if (stop === undefined)
    return { move: "finish_run", status: "succeeded", errorCode: null };
  const position = state.steps.length;
  switch (stop.kind) {
    case "mismatch":
      return {
        move: "finish_run",
        status: "failed",
        errorCode: "document_unusable",
      };
    case "unsupported":
      return {
        move: "finish_run",
        status: "failed",
        errorCode: "step_kind_not_supported",
      };
    case "open":
      // The last row is over only when the machine looked at its status above; a replay that ends here is not a state it can be in.
      return { move: "idle" };
    case "add": {
      const { node } = stop;
      if (node.kind === "if") {
        let holds: boolean;
        try {
          holds = state.holds(node.id, stop.context);
        } catch {
          return conditionFailed();
        }
        return {
          move: "add_if",
          position,
          stepId: node.id,
          round: roundOf(state.steps, node.id),
          taken: holds ? "then" : "else",
          skipped: flatten(holds ? node.else : node.then).flatMap((skipped) =>
            skipped.kind === "unsupported"
              ? []
              : [
                  {
                    stepId: skipped.id,
                    kind: skipped.kind,
                    round: roundOf(state.steps, skipped.id),
                  },
                ],
          ),
        };
      }
      if (node.kind !== "agent" && node.kind !== "action")
        return {
          move: "finish_run",
          status: "failed",
          errorCode: "step_kind_not_supported",
        };
      const round = roundOf(state.steps, node.id);
      if (node.kind === "action")
        return {
          move: "add_step",
          position,
          stepId: node.id,
          kind: "action",
          round,
          capMicroUsd: null,
        };
      const remaining = remainingMicroUsd(state);
      // A task's cost limit is in whole cents: less than one cent cannot be handed out.
      if (remaining < MICRO_USD_PER_CENT)
        return {
          move: "finish_run",
          status: "failed",
          errorCode: "budget_exhausted",
        };
      return {
        move: "add_step",
        position,
        stepId: node.id,
        kind: "agent",
        round,
        capMicroUsd: remaining,
      };
    }
    case "decide_loop": {
      let until: boolean;
      try {
        until = state.holds(stop.loop.id, stop.finished);
      } catch {
        return conditionFailed();
      }
      const exit = until
        ? "until"
        : stop.rounds >= stop.loop.maxRounds
          ? "maxRounds"
          : remainingMicroUsd(state) < MICRO_USD_PER_CENT
            ? "budget"
            : undefined;
      if (exit !== undefined)
        return {
          move: "end_loop",
          position,
          stepId: stop.loop.id,
          round: roundOf(state.steps, stop.loop.id),
          exit,
          rounds: stop.rounds,
        };
      return moveFor(state, stop.again());
    }
  }
}

function conditionFailed(): Move {
  return {
    move: "finish_run",
    status: "failed",
    errorCode: "condition_failed",
  };
}
