// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";
import type { ToolContext } from "../context.ts";
import type { StepView } from "../../../workflow-runs/service.ts";
import {
  laneOfRun,
  runService,
  runUrl,
  workflowRunsService,
} from "./services.ts";

/** One step of a run (the id of a step run, as `get_run` lists it), or a `not_found`. */
export async function stepOfRun(
  context: ToolContext,
  runId: string,
  stepId: string,
): Promise<{ run: { id: string; workflowId: string }; step: StepView }> {
  const laneId = await laneOfRun(context, runId);
  const run = await runService(() =>
    context.services.use(workflowRunsService).get(laneId, runId),
  );
  const step = run.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined)
    throw new ToolError(
      "not_found",
      "This run has no such step. The ids are the `id` of the steps `get_run` lists.",
      { steps: run.steps.map((candidate) => candidate.id) },
    );
  return { run, step };
}

export const getStep = defineTool({
  name: "get_step",
  title: "Get a step of a run",
  description:
    "One step of a run: kind, status, round, cost, output, the question it waits for and `agentRunId`, the id the agent's log is read by (`get_step_log`). Only an agent step that started a turn has an `agentRunId`.",
  scope: "factory:read",
  action: "start_implementer_task",
  input: {
    runId: z.string().min(1).max(128).describe("The id of the run."),
    stepId: z
      .string()
      .min(1)
      .max(128)
      .describe("The `id` of the step, from `get_run`."),
  },
  async handler(context, args) {
    const { run, step } = await stepOfRun(context, args.runId, args.stepId);
    return {
      step,
      agentRunId: step.jobId,
      runId: run.id,
      url: runUrl(context, run),
    };
  },
});
