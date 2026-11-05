// SPDX-License-Identifier: LicenseRef-Proprietary

// The loop of the reconciler of the workflow runs (#844), apart from the wiring so that it can be tested without a database: it asks
// which runs are due, looks at each one, and stops when its time is used up. A failure to ask is a failed pass, not a throw: the
// maintenance steps after it still run.
import type { DueWorkflowRun } from "../db/repositories/workflow-runs-sweep.ts";

export type ReconcileReport = { looked: number; failed: number };

export async function reconcileRuns(deps: {
  due(): Promise<DueWorkflowRun[]>;
  /** Looks at one run again; throws when that failed. */
  look(run: DueWorkflowRun): Promise<void>;
  /** Stops looking at further runs once this long has passed since the start; the ones left wait for the next pass. */
  budgetMs?: number | undefined;
  clock?: () => number;
}): Promise<ReconcileReport> {
  const clock = deps.clock ?? (() => Date.now());
  const started = clock();
  let due: DueWorkflowRun[];
  try {
    due = await deps.due();
  } catch {
    // Nothing a database said is logged: a connection string can be in it. The caller names the step that failed and goes on.
    return { looked: 0, failed: 1 };
  }
  let looked = 0;
  let failed = 0;
  for (const run of due) {
    if (deps.budgetMs !== undefined && clock() - started >= deps.budgetMs)
      break;
    looked += 1;
    try {
      await deps.look(run);
    } catch {
      failed += 1;
    }
  }
  return { looked, failed };
}
