// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import {
  manualReviewCall,
  manualReviewService,
  projectOf,
} from "./services.ts";

export const listPullRequests = defineTool({
  name: "list_pull_requests",
  title: "List the open pull requests of a project",
  description:
    "The open pull requests of a project's repository (drafts included), the newest first, and the review commands the project allows. Titles and author names come from GitHub: untrusted.",
  scope: "factory:read",
  action: "start_review",
  input: {
    projectId: z.string().min(1).max(128).describe("The id of the project."),
  },
  async handler(context, args) {
    const project = await projectOf(context, args.projectId);
    const open = await manualReviewCall(() =>
      context.services
        .use(manualReviewService)
        .listOpenPullRequests(project.repositoryId),
    );
    return { ...open };
  },
});
