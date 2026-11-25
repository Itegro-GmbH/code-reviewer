// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { callHandler, newProjectHandlers } from "./services.ts";

export const createProject = defineTool({
  name: "create_project",
  title: "Create a project",
  description:
    "Creates the project of a repository (`repositoryId` from `list_projects`, `repositoriesWithoutProject`): its ticket source is the repository's GitHub issues (optionally on a GitHub Project `board`) or, with `ticketSource`, a Jira project of a Jira connection of the workspace. `lanes` copies built-in lanes into it (`issue-to-pr`, `issue-to-pr-status`, `one-off-task`, `review-a-pull-request`; a Jira project takes `one-off-task`, `issue-to-pr-status` and `review-a-pull-request`); each copy is reported in the answer. A repository whose project is on already is `conflict`; problems of the request answer `invalid_input` with every one in `issues`. Owners and Admins only.",
  scope: "factory:control",
  action: "manage_projects",
  input: {
    repositoryId: z
      .string()
      .min(1)
      .max(128)
      .describe("The id of the repository (not its name)."),
    board: z
      .object({
        projectV2Id: z
          .string()
          .min(1)
          .max(300)
          .describe("The node id of the GitHub Project (`PVT_…`)."),
      })
      .nullable()
      .optional()
      .describe(
        "The GitHub Project that is the project's board; checked against the repository's boards. Not with a Jira source.",
      ),
    ticketSource: z
      .object({
        provider: z.enum(["github", "jira"]),
        connectionId: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe("Jira only: the id of the workspace's Jira connection."),
        projectKey: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("Jira only: the key of the Jira project, such as `PROJ`."),
      })
      .optional()
      .describe(
        "Where the tickets are; the repository's GitHub issues when left out.",
      ),
    lanes: z
      .array(z.string().min(1).max(100))
      .max(10)
      .optional()
      .describe("The built-in lanes to copy into the new project."),
  },
  async handler(context, args) {
    const handlers = context.services.use(newProjectHandlers);
    return callHandler((request) => handlers.create(request), args);
  },
});
