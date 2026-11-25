// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import {
  laneOfRun,
  runAnswer,
  runService,
  workflowRunsService,
} from "./services.ts";

export const getRun = defineTool({
  name: "get_run",
  title: "Get a run",
  description:
    "One lane run with its steps (status, cost, output, the question of a step that waits), its address in the web app and `waitingFor`: the open questions `answer_run` takes. Use `get_step_log` for what an agent step did.",
  scope: "factory:read",
  action: "start_implementer_task",
  input: { runId: z.string().min(1).max(128).describe("The id of the run.") },
  async handler(context, args) {
    const laneId = await laneOfRun(context, args.runId);
    const run = await runService(() =>
      context.services.use(workflowRunsService).get(laneId, args.runId),
    );
    return runAnswer(context, run);
  },
});
