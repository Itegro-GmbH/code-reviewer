// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";
import { stepOfRun } from "./get-step.ts";
import { runMcpCallsService } from "./services.ts";

export const listRunMcpCalls = defineTool({
  name: "list_run_mcp_calls",
  title: "List the MCP calls of an agent step",
  description:
    "What the agent of a step did with MCP tools (server, tool, outcome, duration), the calls after the cursor. Metadata only: no argument and no answer is stored. Pass the returned `cursor` as `after` to continue.",
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
      .max(Number.MAX_SAFE_INTEGER)
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
      .describe("Calls per answer (default and most: 200)."),
  },
  async handler(context, args) {
    const { step } = await stepOfRun(context, args.runId, args.stepId);
    if (step.jobId === null)
      throw new ToolError(
        "not_found",
        "This step made no MCP calls: only an agent step that started a turn has any.",
      );
    const snapshot = await context.services
      .use(runMcpCallsService)
      .list(step.jobId, args.after ?? 0, args.limit ?? 200);
    if (snapshot === undefined)
      throw new ToolError("not_found", "The calls of this step are not there.");
    return { agentRunId: step.jobId, ...snapshot };
  },
});
