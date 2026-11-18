// SPDX-License-Identifier: LicenseRef-Proprietary

// Where a run stands on every node of its lane (#1079): the step runs of a run laid over the lane document of the version the run
// uses, as a whole tree (triggers with their pre-steps, loops, `if` branches, `onFailure`), keyed by the `stepId` of the node. The rows
// of a step are kept in the order they ran and the LATEST one decides the state of the node, so a loop that is in its second round
// shows the second round. Pure: no clock, no network, nothing from outside is interpreted beyond its type.
//
// What the engine writes (`workflow-runs/machine.ts`): an `agent` or `action` is one row each time it runs; an `if` is one `succeeded`
// row naming the branch, with one `skipped` row for every node of the other branch; a `loop` has NO row while it runs (its row is
// written when it ends), so a loop that runs takes its state from the rows of its body.
import { isRecord } from "../workflows/json.ts";
import { canonicalTriggerKind, TRIGGER_KINDS } from "../workflows/triggers.ts";
import type { TriggerKind } from "../workflows/triggers.ts";
import type { RunView, StepView } from "../workflow-runs/service.ts";
import { nodesOf, normalise, type NodeKind } from "./builder/document.ts";
import { controlResultOf } from "./view.ts";

/** Where a node stands: it ran, it runs, it waits for an answer, it failed, it was passed over, or the run did not get there. */
export const NODE_STATES = [
  "done",
  "running",
  "waiting",
  "failed",
  "skipped",
  "notReached",
] as const;
export type NodeState = (typeof NODE_STATES)[number];

export type NodeRun = {
  stepId: string;
  /** What the document says the node is. */
  kind: NodeKind;
  /** The node as the lane document has it: text of whoever wrote the lane. */
  node: Record<string, unknown>;
  state: NodeState;
  /** The rows of the step, in the order they ran (the rounds of a loop body); empty when it did not run. */
  rows: readonly StepView[];
  /** The newest row, which decides the state. */
  latest: StepView | undefined;
  /** A loop: the round it is in or ended with, and the most it may run; undefined when the loop did not start. */
  round?: number;
  maxRounds?: number;
};

export type NodeStates = {
  byStepId: ReadonlyMap<string, NodeRun>;
  /** The step that runs or waits now (the newest of them), if any. */
  current: string | undefined;
  /** The step that failed (the first one that did), if any. */
  failed: string | undefined;
  /** The step of the newest row. */
  last: string | undefined;
  /** What to select when nothing is asked for: the current step, else the failed one, else the last one, else the first node. */
  fallback: string | undefined;
};

type Context = {
  rows: ReadonlyMap<string, StepView[]>;
  /** The run is not over: a node that has no row may still get one. */
  active: boolean;
  /** Which trigger started the run, or undefined when the run does not say (a run written before triggers had ids, of a kind the lane lacks). */
  firedTrigger: string | undefined;
  found: NodeRun[];
};

/** The state a row stands for. A status a newer server wrote is read as a node that was not reached. */
export function stateOfStatus(status: StepView["status"]): NodeState {
  switch (status) {
    case "succeeded":
      return "done";
    case "pending":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "notReached";
  }
}

/** The state of a node that holds others and has no row of its own (a loop that runs): what its descendants say. */
function stateOfContainer(
  inside: readonly NodeRun[],
  active: boolean,
  unused: boolean,
): NodeState {
  const started = inside.filter((node) => node.state !== "notReached");
  if (started.length === 0) return unused ? "skipped" : "notReached";
  if (started.every((node) => node.state === "skipped")) return "skipped";
  for (const state of ["running", "waiting", "failed"] as const)
    if (started.some((node) => node.state === state)) return state;
  // Everything inside is over and the loop has not written its end yet: it runs while the run does.
  return active ? "running" : "done";
}

function triggerKindOf(kind: unknown): TriggerKind | undefined {
  return (TRIGGER_KINDS as readonly unknown[]).includes(kind)
    ? (kind as TriggerKind)
    : undefined;
}

function firedTriggerOf(
  triggers: readonly { id: string; kind: unknown }[],
  run: Pick<RunView, "trigger" | "triggerId">,
): string | undefined {
  if (run.triggerId !== null)
    return triggers.some((trigger) => trigger.id === run.triggerId)
      ? run.triggerId
      : undefined;
  const wanted = triggerKindOf(run.trigger);
  if (wanted === undefined) return undefined;
  return triggers.find((trigger) => {
    const kind = triggerKindOf(trigger.kind);
    return (
      kind !== undefined &&
      canonicalTriggerKind(kind) === canonicalTriggerKind(wanted)
    );
  })?.id;
}

const KINDS = ["agent", "action", "loop", "if"] as const;

function visitList(
  entries: unknown,
  context: Context,
  unused: boolean,
): NodeRun[] {
  if (!Array.isArray(entries)) return [];
  return (entries as unknown[]).flatMap((entry) =>
    isRecord(entry) ? visitNode(entry, context, unused) : [],
  );
}

function visitNode(
  node: Record<string, unknown>,
  context: Context,
  unused: boolean,
): NodeRun[] {
  const kind = (KINDS as readonly unknown[]).includes(node.kind)
    ? (node.kind as (typeof KINDS)[number])
    : undefined;
  const stepId = typeof node.id === "string" ? node.id : undefined;
  const inside =
    kind === "loop"
      ? visitList(node.body, context, unused)
      : kind === "if"
        ? [
            ...visitList(node.then, context, unused),
            ...visitList(node.else, context, unused),
          ]
        : [];
  if (kind === undefined || stepId === undefined) return inside;
  const rows = context.rows.get(stepId) ?? [];
  const latest = rows.at(-1);
  const found: NodeRun = {
    stepId,
    kind,
    node,
    state:
      latest !== undefined
        ? stateOfStatus(latest.status)
        : stateOfContainer(inside, context.active, unused),
    rows,
    latest,
  };
  if (kind === "loop") {
    // The round: a step of the body counts how often it ran, so the newest round any of them reached is the loop's.
    const reached = Math.max(
      0,
      ...inside.flatMap((each) => each.rows.map((row) => row.round)),
    );
    const ended = controlResultOf({
      kind: "loop",
      output: latest?.output ?? null,
    })?.rounds;
    const round = ended ?? reached;
    if (round > 0) found.round = round;
    if (typeof node.maxRounds === "number") found.maxRounds = node.maxRounds;
  }
  context.found.push(found);
  return [found, ...inside];
}

/**
 * The state of every node of the lane, or undefined when the document is not a lane this page can read (nothing to draw on).
 * `run` says which trigger fired and whether the run is over; `steps` are its rows.
 */
export function nodeStatesOf(
  document: unknown,
  run: Pick<RunView, "status" | "trigger" | "triggerId" | "steps">,
): NodeStates | undefined {
  const doc = normalise(document);
  if (doc === undefined) return undefined;
  const rows = new Map<string, StepView[]>();
  for (const step of [...run.steps].sort((a, b) => a.position - b.position)) {
    const list = rows.get(step.id) ?? [];
    list.push(step);
    rows.set(step.id, list);
  }
  const triggers = nodesOf(doc, "/triggers").flatMap(({ node }) =>
    typeof node.id === "string" ? [{ id: node.id, kind: node.kind, node }] : [],
  );
  const context: Context = {
    rows,
    active: run.status === "running" || run.status === "waiting",
    firedTrigger: firedTriggerOf(triggers, run),
    found: [],
  };
  const byStepId = new Map<string, NodeRun>();
  const place = (found: NodeRun): void => {
    if (!byStepId.has(found.stepId)) byStepId.set(found.stepId, found);
  };
  for (const trigger of triggers) {
    const fired = trigger.id === context.firedTrigger;
    const unused = context.firedTrigger !== undefined && !fired;
    visitList(trigger.node.steps, context, unused);
    place({
      stepId: trigger.id,
      kind: "trigger",
      node: trigger.node,
      state: fired ? "done" : unused ? "skipped" : "notReached",
      rows: [],
      latest: undefined,
    });
  }
  visitList(doc.steps, context, false);
  visitList(doc.onFailure, context, false);
  for (const found of context.found) place(found);
  return summarise(byStepId, run.steps);
}

function summarise(
  byStepId: ReadonlyMap<string, NodeRun>,
  steps: readonly StepView[],
): NodeStates {
  const known = [...steps]
    .filter((step) => byStepId.has(step.id))
    .sort((a, b) => a.position - b.position);
  const active = known.filter(
    (step) =>
      step.status === "running" ||
      step.status === "pending" ||
      step.status === "waiting",
  );
  const current = active.at(-1)?.id;
  const failed = known.find((step) => step.status === "failed")?.id;
  const last = known.at(-1)?.id;
  const first = [...byStepId.values()].find((node) => node.kind !== "trigger");
  return {
    byStepId,
    current,
    failed,
    last,
    fallback: current ?? failed ?? last ?? first?.stepId,
  };
}

/** The node to select: the one the address names when the lane has it, else the default. What the address says is only looked up, never used as it is. */
export function selectionOf(
  states: NodeStates,
  requested: string | null | undefined,
): string | undefined {
  return requested !== null &&
    requested !== undefined &&
    states.byStepId.has(requested)
    ? requested
    : states.fallback;
}
