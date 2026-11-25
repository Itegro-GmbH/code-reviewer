// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { WORKSPACE_RUN_STATUS_FILTERS } from "../../../db/workflow-run-filters.ts";
import { defineTool } from "../define.ts";
import { runService, runUrl, workflowRunsService } from "./services.ts";

export const listRuns = defineTool({
  name: "list_runs",
  title: "List runs",
  description:
    "The lane runs of the workspace, the active ones first, then the newest first, one page at a time. Filter by `status` (active, waiting for an answer, ended, failed), project or lane; pass `nextCursor` back as `cursor` for the next page. Each run has its address in the web app.",
  scope: "factory:read",
  action: "start_implementer_task",
  input: {
    status: z
      .enum(WORKSPACE_RUN_STATUS_FILTERS)
      .optional()
      .describe(
        "`active`: running or waiting; `waiting`: needs an answer; `ended`: succeeded, failed, cancelled or discarded; `failed`.",
      ),
    projectId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Only runs of this project."),
    laneId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Only runs of this lane."),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("`nextCursor` of the previous page."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Runs per page (default 25)."),
  },
  async handler(context, args) {
    const page = await runService(() =>
      context.services.use(workflowRunsService).listWorkspace({
        status: args.status,
        project: args.projectId,
        lane: args.laneId,
        cursor: args.cursor,
        limit: args.limit === undefined ? undefined : String(args.limit),
      }),
    );
    return {
      runs: page.runs.map((run) => {
        // The lane's nodes are the web page's drawing aid, not an answer to an AI.
        const view: Record<string, unknown> = {
          ...run,
          url: runUrl(context, run),
        };
        delete view.nodesKey;
        return view;
      }),
      nextCursor: page.nextCursor,
      now: page.now,
    };
  },
});
