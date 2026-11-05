// SPDX-License-Identifier: LicenseRef-Proprietary

// The workflow document as the engine reads it (#844). The validator checked the form when the version was saved and versions never
// change, so the engine only needs the shape it walks; it still reads the stored text defensively and answers `undefined` for text that
// is not that shape, which fails the run with `document_unusable` instead of throwing.
import { isRecord } from "../workflows/json.ts";
import { BUDGET_DEFAULT_USD } from "../workflows/limits.ts";

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
