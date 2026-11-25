// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import {
  laneOfRun,
  runAnswer,
  runService,
  workflowRunsService,
} from "./services.ts";

export const cancelRun = defineTool({
  name: "cancel_run",
  title: "Cancel a run",
  description:
    "Stops a run and frees its ticket: the run becomes `discarded`, a turn that runs is asked to stop and `onFailure` does not run. Repeating it changes nothing (`outcome` says so). The same engine call as `discard_run`.",
  scope: "factory:control",
  action: "start_implementer_task",
  input: { runId: z.string().min(1).max(128).describe("The id of the run.") },
  async handler(context, args) {
    const laneId = await laneOfRun(context, args.runId);
    const result = await runService(() =>
      context.services.use(workflowRunsService).cancel(laneId, args.runId),
    );
    return { ...runAnswer(context, result.run), outcome: result.outcome };
  },
});
