// SPDX-License-Identifier: LicenseRef-Proprietary

// Where a run stands in its lane (#1078, epic #1077): the step rows of a run laid onto the top-level nodes of the lane version it started
// with. A step row is written under the id of the node it runs, so a node owns its own rows and the rows of everything inside it (the
// branches of an `if`, the body of a `loop`: `LaneNodeView.innerIds`). The list of lane runs draws one dot for each node; the run page
// (#1079) and the step panel (#1080) read the same mapping. Pure: no clock, no network; the inputs are what the run routes answer
// (`LaneNodeView` of `workflow-runs/lane-nodes.ts` and the id, kind, status and round of every step).
import type {
  LaneBodyChild,
  LaneNodeView,
} from "../workflow-runs/lane-nodes.ts";
import { TRACK_COPY } from "./messages.ts";

/**
 * How a node stands. `done`: it ran and nothing in it failed or is still going. `running`: a step of it runs or is queued, or it is a
 * control node (`if`, `loop`) the walk has not left yet. `waiting`: an agent step in it asked a question and waits for the answer.
 * `failed`: a step in it failed. `skipped`: it was never run and was written off (a run that was discarded or stopped first).
 * `not_reached`: the run has not got there, or never will (the run failed before, or it took the other branch: see below).
 */
export type TrackState =
  "done" | "running" | "waiting" | "failed" | "skipped" | "not_reached";

/** What the mapping needs of a step row: the `StepView` of a run and the step summary of the list both have these four. */
export type TrackStepRow = {
  id: string;
  kind: string;
  status: string;
  round: number;
};

export type TrackStep = {
  id: string;
  kind: LaneNodeView["kind"];
  /** The author's note for the node and the connector of an action: the words of the document, text only. */
  note: string | null;
  connector: string | null;
  state: TrackState;
  /** How often a loop went round, or goes round now (1 for any other node, and for a loop that has not started). */
  rounds: number;
};

export type RunTrack = {
  steps: TrackStep[];
  /**
   * The index of the step the run is at: the one that waits, else the one that runs, else the one that failed, else the last one reached
   * (a run that ended), else null (no step has started). A step is what a person would name first when asked "where is it?".
   */
  current: number | null;
};

/** Whether the run still goes on: its status is one of the two a sweep and a poll care about. */
const isActive = (runStatus: string): boolean =>
  runStatus === "running" || runStatus === "waiting";

/**
 * Lays the step rows of a run onto the nodes of its lane.
 *
 * The rows of one node (its own and those inside it) decide its state, in this order: a failed one makes it `failed`, a waiting one
 * `waiting`, a pending or running one `running`. A row that was `skipped` does not count: a branch of an `if` that was not taken is
 * written as skipped rows, and they must not colour the node the `if` belongs to. A node whose rows are all skipped is `skipped`; a node
 * with no rows is `not_reached`. Otherwise it is `done`, with one exception for a run that goes on: the last node it reached is
 * `running` when it is an `if` or a `loop` that has not been closed (a loop writes its own row when it decides to stop; an `if` has no
 * such mark, so it counts as running until a later node has rows), because the steps inside it are written one after the other and the
 * run is between two of them. Rows of the `onFailure` steps belong to no node of the lane and are left out.
 */
export function trackOf(
  nodes: readonly LaneNodeView[],
  steps: readonly TrackStepRow[],
  runStatus: string,
): RunTrack {
  const rowsOf = nodes.map((node) => {
    const ids = new Set([node.id, ...node.innerIds]);
    return steps.filter((step) => ids.has(step.id));
  });
  const lastReached = rowsOf.findLastIndex((rows) => rows.length > 0);
  const track = nodes.map((node, index): TrackStep => {
    const rows = rowsOf[index] ?? [];
    const counted = rows.filter((row) => row.status !== "skipped");
    return {
      id: node.id,
      kind: node.kind,
      note: node.note,
      connector: node.connector,
      state: stateOf(node, rows, counted, index === lastReached, runStatus),
      rounds: roundsOf(node, steps),
    };
  });
  return { steps: track, current: currentOf(track) };
}

/**
 * The rounds of a top-level loop: the most any step of its direct body has begun. `StepRow.round` counts a step over the whole run
 * (the engine's `roundOf`), so a loop in the body, which starts again with every round of the one around it, cannot be read from the
 * rows of the steps inside it. An agent, an action and an `if` write one row each time, a loop writes one when it ends, so a loop in
 * the body counts one more while its own body is going on (a row of something inside it that is newer than its last end). `steps` are
 * in the order they were written. Any other node, and a loop none of whose steps has begun, has 1 round.
 */
function roundsOf(node: LaneNodeView, steps: readonly TrackStepRow[]): number {
  if (node.kind !== "loop") return 1;
  return Math.max(1, ...node.body.map((child) => visitsOf(child, steps)));
}

function visitsOf(
  child: LaneBodyChild,
  steps: readonly TrackStepRow[],
): number {
  const own = steps.flatMap((step, index) =>
    step.id === child.id ? [index] : [],
  );
  if (child.kind !== "loop") return own.length;
  const inner = new Set(child.innerIds);
  const lastEnd = own.at(-1) ?? -1;
  const going = steps.some(
    (step, index) => index > lastEnd && inner.has(step.id),
  );
  return own.length + (going ? 1 : 0);
}

function stateOf(
  node: LaneNodeView,
  rows: readonly TrackStepRow[],
  counted: readonly TrackStepRow[],
  isLastReached: boolean,
  runStatus: string,
): TrackState {
  if (rows.length === 0) return "not_reached";
  if (counted.some((row) => row.status === "failed")) return "failed";
  if (counted.some((row) => row.status === "waiting")) return "waiting";
  if (
    counted.some((row) => row.status === "running" || row.status === "pending")
  )
    return "running";
  if (counted.length === 0) return "skipped";
  if (isLastReached && isActive(runStatus)) {
    // A loop that wrote its own row has decided; an `if` has no such row.
    if (node.kind === "if") return "running";
    if (
      node.kind === "loop" &&
      !counted.some((row) => row.id === node.id && row.kind === "loop")
    )
      return "running";
  }
  return "done";
}

function currentOf(track: readonly TrackStep[]): number | null {
  for (const state of ["waiting", "running", "failed"] as const) {
    const index = track.findIndex((step) => step.state === state);
    if (index >= 0) return index;
  }
  const reached = track.findLastIndex((step) => step.state !== "not_reached");
  return reached >= 0 ? reached : null;
}

/** What a node is called on the track: the author's note, else the connector of an action, else what kind of node it is. */
export function trackStepTitle(
  step: Pick<TrackStep, "kind" | "note" | "connector">,
): string {
  return step.note ?? step.connector ?? TRACK_COPY.kind[step.kind];
}

/**
 * The text alternative of a track: "Step 2 of 4: Review, running". A track without nodes (a lane version that cannot be read) says only
 * where the run is, and a run no step of which has started says so.
 */
export function trackDescription(track: RunTrack): string {
  const { current, steps } = track;
  if (steps.length === 0) return TRACK_COPY.noLane;
  const step = current === null ? undefined : steps[current];
  if (current === null || step === undefined) return TRACK_COPY.notStarted;
  return TRACK_COPY.position(
    current + 1,
    steps.length,
    trackStepTitle(step),
    TRACK_COPY.state[step.state],
  );
}
