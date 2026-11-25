// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";
import {
  laneOfRun,
  openQuestionsOf,
  runAnswer,
  runService,
  workflowRunsService,
} from "./services.ts";

export const answerRun = defineTool({
  name: "answer_run",
  title: "Answer the question of a run",
  description:
    "Answers the question an agent step waits for (a run with `waitingFor` in `get_run`): an option by its number from 1, a text, or both. When the run waits for exactly one question you need not name it; with several, pass `stepRunId` and `n` from `waitingFor`. The step then goes on. The answer is attributed to no GitHub login.",
  scope: "factory:control",
  action: "start_implementer_task",
  input: {
    runId: z.string().min(1).max(128).describe("The id of the run."),
    stepRunId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("`stepRunId` of the question, from `waitingFor`."),
    n: z
      .number()
      .int()
      .optional()
      .describe("`n` of the question, from `waitingFor`."),
    choice: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("The number of an option of the question, from 1."),
    text: z
      .string()
      .max(4000)
      .optional()
      .describe("A free text, or a note that goes with the chosen option."),
  },
  async handler(context, args) {
    const service = context.services.use(workflowRunsService);
    const laneId = await laneOfRun(context, args.runId);
    let question: { stepRunId: string; n: number };
    if (args.stepRunId !== undefined && args.n !== undefined) {
      question = { stepRunId: args.stepRunId, n: args.n };
    } else if (args.stepRunId !== undefined || args.n !== undefined) {
      throw new ToolError(
        "invalid_input",
        "Name the question with both `stepRunId` and `n`, or with neither.",
      );
    } else {
      const open = openQuestionsOf(
        await runService(() => service.get(laneId, args.runId)),
      );
      const only = open[0];
      if (only === undefined)
        throw new ToolError(
          "conflict",
          "This run does not wait for an answer.",
          { code: "WORKFLOW_RUN_NOT_WAITING" },
        );
      if (open.length > 1)
        throw new ToolError(
          "invalid_input",
          "This run waits for several questions: name one with `stepRunId` and `n`.",
          { waitingFor: open },
        );
      question = { stepRunId: only.stepRunId, n: only.n };
    }
    const answered = await runService(() =>
      service.answer(
        { id: context.user.id, githubLogin: null },
        laneId,
        args.runId,
        {
          question,
          ...(args.choice === undefined ? {} : { choice: args.choice }),
          ...(args.text === undefined ? {} : { text: args.text }),
        },
      ),
    );
    return runAnswer(context, answered.run);
  },
});
