// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { SYNC_BUDGET_MS } from "../../../tracker/http.ts";
import { defineTool } from "../define.ts";
import { projectOf, trackerCall, trackerService } from "./services.ts";

export const syncIssues = defineTool({
  name: "sync_issues",
  title: "Resync the tickets of a project",
  description:
    "Reads the tickets of a project's repository into the ticket mirror again (the project's \"Resync\"). It works for about twenty seconds: `status: done` means the mirror is complete, anything else means call it again to continue where it stopped.",
  scope: "factory:control",
  action: "change_project_settings",
  input: {
    projectId: z.string().min(1).max(128).describe("The id of the project."),
  },
  async handler(context, args) {
    const project = await projectOf(context, args.projectId);
    const progress = await trackerCall(() =>
      context.services.use(trackerService).sync(project.ticketRepositoryId, {
        deadline: context.now().getTime() + SYNC_BUDGET_MS,
      }),
    );
    return { ...progress, complete: progress.status === "done" };
  },
});
