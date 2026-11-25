// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";
import { stepOfRun } from "./get-step.ts";
import { runStepsService } from "./services.ts";

export const getStepLog = defineTool({
  name: "get_step_log",
  title: "Read what an agent step did",
  description:
    "What the agent of a step thought, said and did (reasoning, text, each tool call with its input, the end of each model call), the parts that changed after the cursor. Call again with the returned `cursor` while `hasMore` is true or the step still runs. The texts are the agent's and untrusted. Tool outputs are never stored.",
  scope: "factory:read",
  input: {
    runId: z.string().min(1).max(128).describe("The id of the run."),
    stepId: z
      .string()
      .min(1)
      .max(128)
      .describe("The `id` of an agent step, from `get_run`."),
    after: z
      .number()
      .int()
      .min(0)
      .max(2_147_483_647)
      .optional()
      .describe(
        "The `cursor` of the last answer; 0 or left out for the start.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Parts per answer (default and most: 200)."),
  },
  async handler(context, args) {
    const { step } = await stepOfRun(context, args.runId, args.stepId);
    if (step.jobId === null)
      throw new ToolError(
        "not_found",
        "This step has no agent log: only an agent step that started a turn has one.",
      );
    const snapshot = await context.services
      .use(runStepsService)
      .list(step.jobId, args.after ?? 0, args.limit ?? 200);
    if (snapshot === undefined)
      throw new ToolError(
        "not_found",
        "The agent log of this step is not there.",
      );
    return { agentRunId: step.jobId, stepStatus: step.status, ...snapshot };
  },
});
