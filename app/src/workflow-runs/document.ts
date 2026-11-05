// SPDX-License-Identifier: LicenseRef-Proprietary

// The workflow document as the engine reads it (#844). The validator checked the form when the version was saved and versions never
// change, so the engine only needs the shape it walks; it still reads the stored text defensively and answers `undefined` for text that
// is not that shape, which fails the run with `document_unusable` instead of throwing.
import { isRecord } from "../workflows/json.ts";
import { BUDGET_DEFAULT_USD, LOOP_ROUNDS_MAX } from "../workflows/limits.ts";
import { MICRO_USD_COLUMN_MAX, MICRO_USD_PER_USD } from "./limits.ts";
import type { MachineNode } from "./machine.ts";

export type RunDocument = {
  trigger: Record<string, unknown> & { kind: string };
  budgetUsd: number;
  /** The nodes of the workflow, in the order they run. */
  steps: (Record<string, unknown> & { id: string; kind: string })[];
};

export function readRunDocument(text: string): RunDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.trigger)) return undefined;
  const { trigger, steps } = parsed;
  if (typeof trigger.kind !== "string" || !Array.isArray(steps))
    return undefined;
  const nodes: RunDocument["steps"] = [];
  for (const node of steps) {
    if (
      !isRecord(node) ||
      typeof node.id !== "string" ||
      typeof node.kind !== "string"
    )
      return undefined;
    nodes.push(node as RunDocument["steps"][number]);
  }
  const budget = parsed.budgetUsd;
  if (
    budget !== undefined &&
    (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0)
  )
    return undefined;
  return {
    trigger: trigger as RunDocument["trigger"],
    budgetUsd: budget ?? BUDGET_DEFAULT_USD,
    steps: nodes,
  };
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
