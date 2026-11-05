// SPDX-License-Identifier: LicenseRef-Proprietary

// The workflow document as the engine reads it (#844). The validator checked the form when the version was saved and versions never
// change, so the engine only needs the shape it walks; it still reads the stored text defensively and answers `undefined` for text that
// is not that shape, which fails the run with `document_unusable` instead of throwing.
import { isRecord } from "../workflows/json.ts";
import { BUDGET_DEFAULT_USD } from "../workflows/limits.ts";
import { MICRO_USD_COLUMN_MAX, MICRO_USD_PER_USD } from "./limits.ts";

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

/** The first step the engine does not run (only `agent` and `action` steps; `if` and `loop` come with milestone 5), or undefined. */
export function unsupportedStep(
  document: RunDocument,
): RunDocument["steps"][number] | undefined {
  return document.steps.find(
    (step) => step.kind !== "agent" && step.kind !== "action",
  );
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
