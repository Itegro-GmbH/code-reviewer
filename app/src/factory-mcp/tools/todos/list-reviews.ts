// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { JOB_STATUSES } from "../../../db/job-status.ts";
import { defineTool } from "../define.ts";
import { projectOf, reviewRunsService } from "./services.ts";

export const listReviews = defineTool({
  name: "list_reviews",
  title: "List the reviews of pull requests",
  description:
    "The runs of the review product (Diff and Dynamic Reviews of pull requests, and commands like improve or describe), the newest first, at most 100. Filter by project and by status (queued, running, succeeded, failed, cancelled, superseded). This is not the review a ToDo asks a person for: that is `list_todos`.",
  scope: "factory:read",
  input: {
    projectId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Only the reviews of this project."),
    status: z
      .enum(JOB_STATUSES)
      .optional()
      .describe("Only runs in this status."),
  },
  async handler(context, args) {
    const repositoryId =
      args.projectId === undefined
        ? undefined
        : (await projectOf(context, args.projectId)).repositoryId;
    const snapshot = await context.services.use(reviewRunsService).list({
      ...(repositoryId === undefined ? {} : { repositoryId }),
      ...(args.status === undefined ? {} : { status: args.status }),
    });
    return { ...snapshot };
  },
});
