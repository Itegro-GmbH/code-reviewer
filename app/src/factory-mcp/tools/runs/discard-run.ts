// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import {
  laneOfRun,
  runAnswer,
  runService,
  workflowRunsService,
} from "./services.ts";

export const discardRun = defineTool({
  name: "discard_run",
  title: "Discard a run",
  description:
    "Discards a run whatever state it is in (running, waiting, finished): it becomes `discarded` and frees its ticket; a turn that runs is asked to stop. `outcome` is `discarded` or `already_discarded`. The same engine call as `cancel_run`.",
  scope: "factory:control",
  action: "start_implementer_task",
  input: { runId: z.string().min(1).max(128).describe("The id of the run.") },
  async handler(context, args) {
    const laneId = await laneOfRun(context, args.runId);
    const result = await runService(() =>
      context.services.use(workflowRunsService).discard(laneId, args.runId),
    );
    return { ...runAnswer(context, result.run), outcome: result.outcome };
  },
});
