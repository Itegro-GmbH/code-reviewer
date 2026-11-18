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
  /** The step of the newest row that was not passed over (any newest row when every row was). */
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
  // Two triggers of one kind: nothing says which of them fired, and a wrong answer is worse than none.
  const same = triggers.filter((trigger) => {
    const kind = triggerKindOf(trigger.kind);
    return (
      kind !== undefined &&
      canonicalTriggerKind(kind) === canonicalTriggerKind(wanted)
    );
  });
  return same.length === 1 ? same[0]?.id : undefined;
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

/**
 * How often a direct child of a loop body has begun in the part of the run after `from` (a position): an agent, an action and an
 * `if` write a row each time, a loop writes one when it ends, so a loop that runs counts one more. The rows of a step count over the
 * whole run (`StepView.round` is cumulative), so the round a loop is in cannot be read from them; this counts in one pass of the loop.
 */
function visitsAfter(group: readonly NodeRun[], from: number): number {
  const child = group[0];
  if (child === undefined) return 0;
  const own = child.rows.filter((row) => row.position > from);
  if (child.kind !== "loop") return own.length;
  const lastEnd = own.at(-1)?.position ?? from;
  const running = group
    .slice(1)
    .some((inner) => inner.rows.some((row) => row.position > lastEnd));
  return own.length + (running ? 1 : 0);
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
  // The direct children of a loop body, each with what is inside it (the first of a group is the child itself).
  const groups: NodeRun[][] =
    kind === "loop" && Array.isArray(node.body)
      ? (node.body as unknown[]).flatMap((entry) =>
          isRecord(entry) ? [visitNode(entry, context, unused)] : [],
        )
      : [];
  const inside =
    kind === "loop"
      ? groups.flat()
      : kind === "if"
        ? [
            ...visitList(node.then, context, unused),
            ...visitList(node.else, context, unused),
          ]
        : [];
  if (kind === undefined || stepId === undefined) return inside;
  const rows = context.rows.get(stepId) ?? [];
  if (kind !== "loop") {
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
    context.found.push(found);
    return [found, ...inside];
  }
  // A loop writes its row when it ends, once for every pass of the loop it is in. Rows of its body that are newer than that row belong
  // to a pass that is not over: they decide, and the end row of the earlier pass is not the result any more.
  const ended = rows.at(-1);
  const from = ended?.position ?? -1;
  const passing = inside.some((each) =>
    each.rows.some((row) => row.position > from),
  );
  const latest = passing ? undefined : ended;
  const state =
    latest !== undefined
      ? stateOfStatus(latest.status)
      : stateOfContainer(inside, context.active, unused);
  const found: NodeRun = { stepId, kind, node, state, rows, latest };
  // The round of this pass: the most any step of the body has begun since the pass started, so a loop in a loop counts per pass of
  // the outer one. A loop that was passed over or did not start has none.
  const round =
    latest !== undefined
      ? controlResultOf({ kind: "loop", output: latest.output })?.rounds
      : state === "skipped" || state === "notReached"
        ? undefined
        : Math.max(0, ...groups.map((group) => visitsAfter(group, from)));
  if (round !== undefined && round > 0) found.round = round;
  if (typeof node.maxRounds === "number") found.maxRounds = node.maxRounds;
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
  // A row that was passed over (or whose status is unknown) is not where the run got to.
  const ran = known.filter((step) => {
    const state = stateOfStatus(step.status);
    return state !== "skipped" && state !== "notReached";
  });
  const last = (ran.length > 0 ? ran : known).at(-1)?.id;
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
