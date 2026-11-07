// SPDX-License-Identifier: LicenseRef-Proprietary

// What the latest run of a workflow held (#927), as the samples the picker of the lane builder shows next to a value: the trigger's
// values, the output of each step that succeeded (of a step that ran in several rounds, the latest) and, when the run began its
// `onFailure` steps, the failure. Display only: the engine reads the same stored texts for the real values (`engine.ts`, `valuesOf`).
import type { WorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { isRecord } from "../workflows/json.ts";
import type { ReachSamples } from "../workflows/reach.ts";
import {
  canonicalTriggerKind,
  legacyTriggerId,
  type TriggerKind,
} from "../workflows/triggers.ts";
import { readStoredInput } from "./ticket.ts";

function parse(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The samples of the newest run of the workflow, or `undefined` when it has not run. */
export async function latestRunSamples(
  runs: Pick<WorkflowRunsRepository, "listRuns" | "listSteps">,
  workflowId: string,
): Promise<ReachSamples | undefined> {
  const [run] = await runs.listRuns(workflowId, 1);
  if (run === undefined) return undefined;
  const stored = parse(run.triggerInput);
  const kind = canonicalTriggerKind(run.triggerKind as TriggerKind);
  const facts = { id: run.triggerId ?? legacyTriggerId(kind), kind };
  const trigger =
    kind === "manual" || kind === "api"
      ? { ...facts, ...readStoredInput(stored) }
      : { ...facts, ...(isRecord(stored) ? stored : {}) };
  const steps: Record<string, unknown> = {};
  for (const step of await runs.listSteps(run.id))
    if (step.status === "succeeded") steps[step.stepId] = parse(step.output);
  const failure = parse(run.failure);
  return {
    trigger,
    steps,
    ...(isRecord(failure) ? { failure } : {}),
  };
}
