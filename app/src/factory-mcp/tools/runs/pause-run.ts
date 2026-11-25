// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import {
  laneOfRun,
  runAnswer,
  runService,
  workflowRunsService,
} from "./services.ts";

export const pauseRun = defineTool({
  name: "pause_run",
  title: "Pause a run",
  description:
    "Asks an active run to stop after its current step: the step that runs goes on, none starts until `resume_run`. `outcome` is `changed`, or `unchanged` for a run that is paused already or over.",
  scope: "factory:control",
  action: "start_implementer_task",
  input: { runId: z.string().min(1).max(128).describe("The id of the run.") },
  async handler(context, args) {
    const laneId = await laneOfRun(context, args.runId);
    const result = await runService(() =>
      context.services.use(workflowRunsService).pause(laneId, args.runId),
    );
    return { ...runAnswer(context, result.run), outcome: result.outcome };
  },
});
