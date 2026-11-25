// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import {
  laneOfRun,
  runAnswer,
  runService,
  workflowRunsService,
} from "./services.ts";

export const resumeRun = defineTool({
  name: "resume_run",
  title: "Resume a run",
  description:
    "Takes the pause off a run so the next step starts. `outcome` is `changed`, or `unchanged` when the run was not paused or is over.",
  scope: "factory:control",
  action: "start_implementer_task",
  input: { runId: z.string().min(1).max(128).describe("The id of the run.") },
  async handler(context, args) {
    const laneId = await laneOfRun(context, args.runId);
    const result = await runService(() =>
      context.services.use(workflowRunsService).resume(laneId, args.runId),
    );
    return { ...runAnswer(context, result.run), outcome: result.outcome };
  },
});
