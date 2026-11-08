// SPDX-License-Identifier: LicenseRef-Proprietary

// The workflow document as the engine reads it (#844). The validator checked the form when the version was saved and versions never
// change, so the engine only needs the shape it walks; it still reads the stored text defensively and answers `undefined` for text that
// is not that shape, which fails the run with `document_unusable` instead of throwing.
import { isRecord } from "../workflows/json.ts";
import {
  BUDGET_DEFAULT_USD,
  LOOP_ROUNDS_MAX,
  TURN_TIME_LIMIT_MINUTES_DEFAULT,
  TURN_TIME_LIMIT_MINUTES_MAX,
  TURN_TIME_LIMIT_MINUTES_MIN,
} from "../workflows/limits.ts";
import {
  TRIGGER_KINDS,
  canonicalTriggerKind,
  legacyTriggerId,
  type CanonicalTriggerKind,
  type TriggerKind,
} from "../workflows/triggers.ts";
import { MICRO_USD_COLUMN_MAX, MICRO_USD_PER_USD } from "./limits.ts";
import type { MachineNode } from "./machine.ts";

type RunNode = Record<string, unknown> & { id: string; kind: string };

/**
 * A trigger of the document (#916). A document written with the single `trigger` is read as a list of one, without pre-steps, and
 * `github.issueLabeled` as `ticket.labeled`.
 */
export type RunTrigger = {
  id: string;
  kind: CanonicalTriggerKind;
  /** `label` of a label trigger. */
  label?: string;
  /** `input` of a manual or api trigger, the result schema as written. */
  input?: unknown;
  /** The steps that run first when this trigger started the run, before the shared ones. */
  steps: RunNode[];
};

export type RunDocument = {
  triggers: RunTrigger[];
  budgetUsd: number;
  /** How long one agent turn of the run may run, in minutes (#918); the default when the document names none. */
  turnTimeLimitMinutes: number;
  /** The nodes of the workflow, in the order they run; of a document made `forTrigger` the pre-steps of that trigger come first. */
  steps: RunNode[];
  /** The steps that run once after the run ended `failed` or `cancelled` (#902); empty when the workflow has none. */
  onFailure: RunNode[];
};

function readTrigger(raw: unknown, legacy: boolean): RunTrigger | undefined {
  if (!isRecord(raw) || typeof raw.kind !== "string") return undefined;
  if (!(TRIGGER_KINDS as readonly string[]).includes(raw.kind))
    return undefined;
  const kind = raw.kind as TriggerKind;
  const id = legacy ? legacyTriggerId(kind) : raw.id;
  if (typeof id !== "string") return undefined;
  const steps = raw.steps === undefined || legacy ? [] : readNodes(raw.steps);
  if (steps === undefined) return undefined;
  return {
    id,
    kind: canonicalTriggerKind(kind),
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    ...(raw.input === undefined ? {} : { input: raw.input }),
    steps,
  };
}

export function readRunDocument(text: string): RunDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.steps)) return undefined;
  const triggers: RunTrigger[] = [];
  if (Array.isArray(parsed.triggers)) {
    for (const raw of parsed.triggers as unknown[]) {
      const trigger = readTrigger(raw, false);
      if (trigger === undefined) return undefined;
      triggers.push(trigger);
    }
  } else {
    const trigger = readTrigger(parsed.trigger, true);
    if (trigger === undefined) return undefined;
    triggers.push(trigger);
  }
  if (triggers.length === 0) return undefined;
  const nodes = readNodes(parsed.steps);
  if (nodes === undefined) return undefined;
  // A document without `onFailure` has none; one whose `onFailure` is not a list of nodes is not usable (the validator never saved one).
  const failureNodes =
    parsed.onFailure === undefined ? [] : readNodes(parsed.onFailure);
  if (failureNodes === undefined) return undefined;
  const budget = parsed.budgetUsd;
  if (
    budget !== undefined &&
    (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0)
  )
    return undefined;
  const turnLimit = parsed.turnTimeLimitMinutes;
  if (
    turnLimit !== undefined &&
    (typeof turnLimit !== "number" ||
      !Number.isInteger(turnLimit) ||
      turnLimit < TURN_TIME_LIMIT_MINUTES_MIN ||
      turnLimit > TURN_TIME_LIMIT_MINUTES_MAX)
  )
    return undefined;
  return {
    triggers,
    budgetUsd: budget ?? BUDGET_DEFAULT_USD,
    turnTimeLimitMinutes: turnLimit ?? TURN_TIME_LIMIT_MINUTES_DEFAULT,
    steps: nodes,
    onFailure: failureNodes,
  };
}

/**
 * The trigger a run was started by: the one with this id, or, for a run written before triggers had ids (`id` null), the first of that
 * kind (`github.issueLabeled` is `ticket.labeled`). Undefined when the document has none.
 */
export function triggerOf(
  document: RunDocument,
  ref: { id: string | null; kind: string },
): RunTrigger | undefined {
  if (ref.id !== null) return document.triggers.find((t) => t.id === ref.id);
  const kind = (TRIGGER_KINDS as readonly string[]).includes(ref.kind)
    ? canonicalTriggerKind(ref.kind as TriggerKind)
    : ref.kind;
  return document.triggers.find((t) => t.kind === kind);
}

/**
 * The document as a run started by `trigger` runs it: the pre-steps of that trigger, then the shared steps. The state machine walks
 * this one list, so a pre-step is a step like any other. Undefined when the document has no such trigger.
 */
export function forTrigger(
  document: RunDocument,
  ref: { id: string | null; kind: string },
): RunDocument | undefined {
  const trigger = triggerOf(document, ref);
  if (trigger === undefined) return undefined;
  return { ...document, steps: [...trigger.steps, ...document.steps] };
}

/** A list of nodes as the engine walks them, or undefined when it is not a list of objects with an id and a kind. */
function readNodes(list: unknown): RunDocument["steps"] | undefined {
  if (!Array.isArray(list)) return undefined;
  const nodes: RunDocument["steps"] = [];
  for (const node of list as unknown[]) {
    if (
      !isRecord(node) ||
      typeof node.id !== "string" ||
      typeof node.kind !== "string"
    )
      return undefined;
    nodes.push(node as RunDocument["steps"][number]);
  }
  return nodes;
}

/** The kinds of node the engine runs. The format's reserved kinds are refused by the validator, so a saved document holds only these. */
const RUN_KINDS: ReadonlySet<string> = new Set([
  "agent",
  "action",
  "if",
  "loop",
]);

/** The nodes inside a node: the two branches of an `if`, the body of a loop. A list that is not a list of nodes reads as empty. */
export function childrenOf(
  node: RunDocument["steps"][number],
): RunDocument["steps"] {
  const lists: unknown[] =
    node.kind === "if"
      ? [node.then, node.else]
      : node.kind === "loop"
        ? [node.body]
        : [];
  return lists.flatMap((list) =>
    Array.isArray(list)
      ? list.filter(
          (child): child is RunDocument["steps"][number] =>
            isRecord(child) &&
            typeof child.id === "string" &&
            typeof child.kind === "string",
        )
      : [],
  );
}

/**
 * The nodes as the state machine walks them. A node that is not well formed (a kind the engine does not run, a loop without a usable
 * `maxRounds`) is `unsupported`: the run that reaches it ends with `step_kind_not_supported` instead of throwing.
 */
export function machineNodes(
  nodes: readonly unknown[] | undefined,
): MachineNode[] {
  return (nodes ?? []).flatMap((raw): MachineNode[] => {
    if (!isRecord(raw) || typeof raw.id !== "string") return [];
    const id = raw.id;
    const list = (value: unknown): MachineNode[] =>
      machineNodes(Array.isArray(value) ? (value as unknown[]) : undefined);
    switch (raw.kind) {
      case "agent":
      case "action":
        return [{ kind: raw.kind, id }];
      case "if":
        return [{ kind: "if", id, then: list(raw.then), else: list(raw.else) }];
      case "loop": {
        const rounds = raw.maxRounds;
        return typeof rounds === "number" &&
          Number.isInteger(rounds) &&
          rounds >= 1 &&
          rounds <= LOOP_ROUNDS_MAX
          ? [{ kind: "loop", id, maxRounds: rounds, body: list(raw.body) }]
          : [{ kind: "unsupported", id }];
      }
      default:
        return [{ kind: "unsupported", id }];
    }
  });
}

/** Every node of the document by id, branches and loop bodies included (ids are unique in a saved document). */
export function nodesById(
  document: RunDocument,
): Map<string, RunDocument["steps"][number]> {
  const found = new Map<string, RunDocument["steps"][number]>();
  const walk = (nodes: RunDocument["steps"]): void => {
    for (const node of nodes) {
      found.set(node.id, node);
      walk(childrenOf(node));
    }
  };
  walk(document.steps);
  walk(document.onFailure);
  return found;
}

/** The first node, at any depth, of a kind the engine does not run, or undefined. */
export function unsupportedStep(
  document: RunDocument,
): RunDocument["steps"][number] | undefined {
  const find = (
    nodes: RunDocument["steps"],
  ): RunDocument["steps"][number] | undefined => {
    for (const node of nodes) {
      if (!RUN_KINDS.has(node.kind)) return node;
      const inside = find(childrenOf(node));
      if (inside !== undefined) return inside;
    }
    return undefined;
  };
  return find(document.steps);
}

/** What a run of the document may spend: its budget, capped by the operator's maximum, in the unit of the column. */
export function runBudgetMicroUsd(
  document: RunDocument,
  maxBudgetUsd: number,
): number {
  return Math.min(
    MICRO_USD_COLUMN_MAX,
    Math.max(
      1,
      Math.round(
        Math.min(document.budgetUsd, maxBudgetUsd) * MICRO_USD_PER_USD,
      ),
    ),
  );
}
