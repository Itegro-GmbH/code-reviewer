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
// `onFailure` (#902): when the walk would end the run `failed` or `cancelled`, the machine first answers `begin_failure` with how the run
// ends and why (`FailureRecord`, stored with the run). From then on the run is in its failure phase: the rows after the ones of the
// workflow are the rows of `onFailure`, replayed against its nodes the same way, and only they matter. A step of it that fails is
// recorded and the next one runs; a cancel asked for meanwhile changes nothing; the run ends with the status the record holds. An agent
// step or a loop is never started there (the validator refuses them; the machine does not trust the document).
//
// A turn can end with a question (#920): the step is then `waiting` and so is the run, and nothing else of the run runs until somebody answers
// (there is no deadline). The answer makes both `running` again with the answer on the step (`answerPending`): the next move starts the turn that
// goes on in the same session (`resume_turn`), and the step reads that turn like any other. A stop asked for while the run waits ends the step as
// cancelled at once (`cancel_waiting`).
//
// A run can be paused (#921, `pauseRequested`): the step that runs goes on and is read, and no further step of the workflow is written or
// started until the run is resumed. A discarded run (#921) is over for the engine: `nextMove` does nothing for it, and the engine's `discard`
// ends its steps itself.
//
// A run is `running` until the walk is over (`succeeded`), a step failed or the budget ran out (`failed`), or a member stopped it (`cancelled`, #891:
// once a stop is asked for, no step is written or started any more; a turn that runs is asked to stop, a step that did not start is
// skipped, and the run ends when nothing runs).
import { FAILURE_MESSAGE_MAX_CHARS, MICRO_USD_PER_CENT } from "./limits.ts";
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
  status:
    "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped";
  kind: "agent" | "action" | "if" | "loop";
  /** #920: the step's question was answered and the turn that goes on has not been started yet. */
  answerPending?: boolean;
  /** An agent step has a job once its turn is queued. */
  hasJob: boolean;
  /** When the step was written. */
  createdAt: string;
  /** When the step was claimed; null for a step nobody has taken yet. */
  startedAt: string | null;
  /** Why a failed step failed (`cancelled` for a turn a member stopped, #891). */
  errorCode?: string | null;
  /** What the failed step said, for the failure of the run (#902). */
  errorMessage?: string | null;
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

/**
 * How a run ended, recorded when its `onFailure` steps begin (#902) and read by them as `{{failure.*}}`. `status` and `errorCode` are what the
 * run ends with afterwards; `stepId` is the step the failure belongs to (empty when no step does: a run cancelled before its first step),
 * `code` the code of that step or of the run, and `message` a short sentence, at most `FAILURE_MESSAGE_MAX_CHARS` long.
 */
export type FailureRecord = {
  status: "failed" | "cancelled";
  errorCode: RunFailureCode | null;
  stepId: string;
  code: string;
  message: string;
};

export type MachineState = {
  runStatus:
    "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "discarded";
  /** A member asked for the run to stop (#891). Legacy: a member discards a run now (#921), which never reaches the machine. */
  cancelRequested: boolean;
  /** A member asked the run to stop after its current step (#921): no step of the workflow starts until it is resumed. */
  pauseRequested?: boolean;
  budgetMicroUsd: number;
  spentMicroUsd: number;
  /** The steps written so far, by position. */
  steps: readonly MachineStep[];
  /** The nodes of the pinned document, in order. */
  nodes: readonly MachineNode[];
  /** The nodes of `onFailure`, in order; none when the workflow has none (#902). */
  onFailure: readonly MachineNode[];
  /** How the run ended, once its `onFailure` steps have begun; null before (#902). */
  failure: FailureRecord | null;
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
  /** #902: the run would end failed or cancelled and the workflow has `onFailure` steps: store how it ends, and run them. */
  | { move: "begin_failure"; failure: FailureRecord }
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
  /** #920: a question was answered: start the turn that goes on in the step's session, with the answer as its instruction. */
  | { move: "resume_turn"; position: number }
  /** #920: a stop was asked for while the run waits for an answer: the step ends cancelled, and the run follows. */
  | { move: "cancel_waiting"; position: number }
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
      /** The step a run-level failure belongs to (the agent step the budget could not pay, the control step whose condition failed). */
      stepId?: string;
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

/**
 * Walks the rows over the nodes: see the top of this file. Pure. `tolerant` (the steps of `onFailure`, #902): a step that failed or was
 * skipped is over like a succeeded one, because the steps after it still run.
 */
export function replay(
  nodes: readonly MachineNode[],
  steps: readonly MachineStep[],
  options: { tolerant?: boolean } = {},
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
        if (
          options.tolerant === true &&
          (row.status === "failed" || row.status === "skipped")
        )
          return undefined;
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
    case "waiting":
      return { move: "cancel_waiting", position };
    case "running":
      // #920: the answer came and the turn it starts does not exist yet: it is started first (under its request id, so once), and then stopped.
      if (last.kind === "agent" && last.hasJob && last.answerPending === true)
        return { move: "resume_turn", position };
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

/** The move of the workflow itself: the walk over `nodes`, or the stop a member asked for. Not the failure phase. */
function workflowMove(state: MachineState): Move {
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
      case "waiting":
        // #920: the run waits for a person; the answer is what makes it move.
        return { move: "idle" };
      case "running":
        if (last.kind === "agent" && last.hasJob && last.answerPending === true)
          return { move: "resume_turn", position };
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

const FAILURE_MESSAGES = {
  budget_exhausted:
    "The budget of the workflow cannot pay for another agent step.",
  condition_failed:
    "A condition could not be told: a value it needs does not exist.",
  step_kind_not_supported:
    "The workflow holds a step this engine does not run.",
  cancelled: "The run was cancelled.",
  step_failed: "The step failed.",
} as const;

const clipMessage = (text: string): string =>
  text.length <= FAILURE_MESSAGE_MAX_CHARS
    ? text
    : `${text.slice(0, FAILURE_MESSAGE_MAX_CHARS - 1)}…`;

/** How a run that is about to end `failed` or `cancelled` ended, for the steps of `onFailure`: see `FailureRecord`. */
function failureOf(
  state: MachineState,
  end: Extract<Move, { move: "finish_run" }> & {
    status: "failed" | "cancelled";
  },
): FailureRecord {
  const last = state.steps[state.steps.length - 1];
  const row = last?.status === "failed" ? last : undefined;
  const rowMessage =
    row?.errorMessage == null || row.errorMessage.trim() === ""
      ? undefined
      : clipMessage(row.errorMessage);
  if (end.status === "cancelled")
    return {
      status: "cancelled",
      errorCode: null,
      stepId: row?.stepId ?? "",
      code: "cancelled",
      message: rowMessage ?? FAILURE_MESSAGES.cancelled,
    };
  if (end.errorCode === "step_failed")
    return {
      status: "failed",
      errorCode: "step_failed",
      stepId: row?.stepId ?? "",
      code: row?.errorCode ?? "step_failed",
      message: rowMessage ?? FAILURE_MESSAGES.step_failed,
    };
  const code = end.errorCode ?? "step_failed";
  return {
    status: "failed",
    errorCode: end.errorCode,
    stepId: end.stepId ?? "",
    code,
    message:
      code === "budget_exhausted" ||
      code === "condition_failed" ||
      code === "step_kind_not_supported"
        ? FAILURE_MESSAGES[code]
        : FAILURE_MESSAGES.step_failed,
  };
}

/** The index of the first row of the failure phase: the rows of `onFailure` come after the rows of the workflow, ids being unique in a document. */
function failureStart(
  onFailure: readonly MachineNode[],
  steps: readonly MachineStep[],
): number {
  const ids = new Set(flatten(onFailure).map((node) => node.id));
  const first = steps.findIndex((row) => ids.has(row.stepId));
  return first === -1 ? steps.length : first;
}

/** The nodes of `onFailure` as the failure phase walks them: an agent step and a loop are never started there, whatever the document says. */
function safeNodes(nodes: readonly MachineNode[]): MachineNode[] {
  return nodes.map((node): MachineNode => {
    if (node.kind === "agent" || node.kind === "loop")
      return { kind: "unsupported", id: node.id };
    if (node.kind === "if")
      return {
        ...node,
        then: safeNodes(node.then),
        else: safeNodes(node.else),
      };
    return node;
  });
}

/**
 * The context of the row at `position` (all rows, the failure phase included), or undefined when the rows do not fit the document: for
 * the rows of the workflow the walk over `nodes`, for the rows of `onFailure` the walk over its nodes.
 */
export function contextOf(
  nodes: readonly MachineNode[],
  onFailure: readonly MachineNode[],
  steps: readonly MachineStep[],
  position: number,
): RoundContext | undefined {
  const start = failureStart(onFailure, steps);
  return position < start
    ? replay(nodes, steps.slice(0, start)).contexts[position]
    : replay(safeNodes(onFailure), steps.slice(start), { tolerant: true })
        .contexts[position - start];
}

/** The failure phase (#902): the steps of `onFailure` one after the other, then the end the run was going to have. */
function failureMove(state: MachineState, failure: FailureRecord): Move {
  const start = failureStart(state.onFailure, state.steps);
  const rows = state.steps.slice(start);
  const last = rows[rows.length - 1];
  const position = state.steps.length - 1;
  if (last !== undefined) {
    // Only an action runs here; a step that is not claimed yet is done, one that is claimed is waited for or, when its claimant is gone,
    // told so: it is not repeated, and the steps after it go on.
    if (last.status === "pending")
      return { move: "execute", position, takeOver: false };
    if (last.status === "running")
      return isStale(last, state.now, state.staleMs)
        ? { move: "fail_step", position, code: "action_interrupted" }
        : { move: "idle" };
  }
  const { stop } = replay(safeNodes(state.onFailure), rows, { tolerant: true });
  return moveFor(state, stop, failure);
}

/** #920: a run that waits for an answer does nothing, unless it was asked to stop. */
function waitingMove(state: MachineState): Move {
  const last = state.steps[state.steps.length - 1];
  return state.cancelRequested && last?.status === "waiting"
    ? { move: "cancel_waiting", position: state.steps.length - 1 }
    : { move: "idle" };
}

export function nextMove(state: MachineState): Move {
  if (state.runStatus === "waiting") return waitingMove(state);
  if (state.runStatus !== "running") return { move: "idle" };
  if (state.failure !== null) return failureMove(state, state.failure);
  const move = workflowMove(state);
  // #921: paused. The step that runs goes on and is read; the next one is not written or started (the steps of `onFailure` are not held).
  if (
    state.pauseRequested === true &&
    (move.move === "add_step" || (move.move === "execute" && !move.takeOver))
  )
    return { move: "idle" };
  if (
    move.move !== "finish_run" ||
    move.status === "succeeded" ||
    state.onFailure.length === 0 ||
    // Rows that are not what the document says: nothing of this run can be trusted, not even to comment on an issue.
    move.errorCode === "document_unusable"
  )
    return move;
  return {
    move: "begin_failure",
    failure: failureOf(state, { ...move, status: move.status }),
  };
}

function moveFor(
  state: MachineState,
  stop: Stop | undefined,
  failure?: FailureRecord,
): Move {
  // In the failure phase every way the walk can stop short ends the run the way it was going to end; it never fails again.
  const end = (otherwise: Move): Move =>
    failure === undefined
      ? otherwise
      : {
          move: "finish_run",
          status: failure.status,
          errorCode: failure.errorCode,
        };
  if (stop === undefined)
    return end({ move: "finish_run", status: "succeeded", errorCode: null });
  const position = state.steps.length;
  switch (stop.kind) {
    case "mismatch":
      return end({
        move: "finish_run",
        status: "failed",
        errorCode: "document_unusable",
      });
    case "unsupported":
      return end({
        move: "finish_run",
        status: "failed",
        errorCode: "step_kind_not_supported",
        stepId: stop.node.id,
      });
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
          return end(conditionFailed(node.id));
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
        return end({
          move: "finish_run",
          status: "failed",
          errorCode: "step_kind_not_supported",
          stepId: node.id,
        });
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
        return end({
          move: "finish_run",
          status: "failed",
          errorCode: "budget_exhausted",
          stepId: node.id,
        });
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
        return end(conditionFailed(stop.loop.id));
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
      return moveFor(state, stop.again(), failure);
    }
  }
}

function conditionFailed(stepId: string): Move {
  return {
    move: "finish_run",
    status: "failed",
    errorCode: "condition_failed",
    stepId,
  };
}
