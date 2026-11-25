// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { REVIEW_DECISIONS } from "../../../todos/review.ts";
import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";
import {
  runAnswer,
  runService,
  workflowRunsService,
} from "../runs/services.ts";
import {
  VIEWER,
  reviewActions,
  todoService,
  todosService,
} from "./services.ts";

export const resolveTodo = defineTool({
  name: "resolve_todo",
  title: "Resolve a ToDo",
  description:
    "Resolves an open ToDo by its `id` from `list_todos`. A question (`question:...`): pass `choice` (the number of an option, from 1), `text`, or both; the agent step goes on. A review (`review:...`): pass `decision` (`approve` or `request_changes`) and an optional `comment`; it is posted as a review of the GitHub App on the pull request. A ToDo that is not open is `not_found`.",
  scope: "factory:control",
  action: "start_implementer_task",
  input: {
    id: z
      .string()
      .min(1)
      .max(300)
      .describe("The `id` of the ToDo, from `list_todos`."),
    choice: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("A question: the number of an option, from 1."),
    text: z
      .string()
      .max(4000)
      .optional()
      .describe("A question: a free text, or a note with the chosen option."),
    decision: z
      .enum(REVIEW_DECISIONS)
      .optional()
      .describe("A review: `approve` or `request_changes`."),
    comment: z
      .string()
      .max(4000)
      .optional()
      .describe("A review: a note that goes with the decision."),
  },
  async handler(context, args) {
    const list = await todoService(() =>
      context.services.use(todosService).list(VIEWER),
    );
    const question = list.questions.find((todo) => todo.id === args.id);
    const review = list.reviews.find((todo) => todo.id === args.id);
    if (question !== undefined) {
      if (args.decision !== undefined || args.comment !== undefined)
        throw new ToolError(
          "invalid_input",
          "A question is answered with `choice` and `text`, not with a decision or a comment.",
        );
      if (args.choice === undefined && args.text === undefined)
        throw new ToolError(
          "invalid_input",
          "Answer the question with a `choice`, a `text`, or both.",
          {
            options: question.options,
          },
        );
      const answered = await runService(() =>
        context.services
          .use(workflowRunsService)
          .answer(
            { id: context.user.id, githubLogin: null },
            question.workflowId,
            question.runId,
            {
              question: { stepRunId: question.stepRunId, n: question.n },
              ...(args.choice === undefined ? {} : { choice: args.choice }),
              ...(args.text === undefined ? {} : { text: args.text }),
            },
          ),
      );
      return {
        kind: "question",
        id: args.id,
        ...runAnswer(context, answered.run),
      };
    }
    if (review !== undefined) {
      if (args.choice !== undefined || args.text !== undefined)
        throw new ToolError(
          "invalid_input",
          "A review is resolved with `decision` and `comment`, not with a choice or a text.",
        );
      if (args.decision === undefined)
        throw new ToolError(
          "invalid_input",
          "Resolve the review with a `decision`: approve or request_changes.",
          {
            available: REVIEW_DECISIONS,
          },
        );
      const decision = args.decision;
      const outcome = await todoService(() =>
        context.services.use(reviewActions).submit(VIEWER, {
          repositoryId: review.repositoryId,
          number: review.number,
          decision,
          comment: args.comment ?? "",
        }),
      );
      return { kind: "review", id: args.id, ...outcome };
    }
    throw new ToolError(
      "not_found",
      "There is no open ToDo with this id. `list_todos` lists them.",
    );
  },
});
