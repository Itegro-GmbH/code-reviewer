// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { callHandler, newProjectHandlers } from "./services.ts";
import { projectIdArg } from "./shared.ts";

export const updateProject = defineTool({
  name: "update_project",
  title: "Set the board of a project",
  description:
    "Sets, changes or clears (`board: null`) the GitHub Project that is the board of a project's ticket source; it is checked against the boards of the project's repository (an unknown one answers `invalid_input` listing the ids it has). The board is the only thing of a project that can change: its repository never does. Not for a project whose tickets are a Jira project's. Owners and Admins only.",
  scope: "factory:control",
  action: "manage_projects",
  input: {
    projectId: projectIdArg,
    board: z
      .object({
        projectV2Id: z
          .string()
          .min(1)
          .max(300)
          .describe("The node id of the GitHub Project (`PVT_…`)."),
      })
      .nullable()
      .describe("The new board, or `null` for no board."),
  },
  async handler(context, args) {
    const handlers = context.services.use(newProjectHandlers);
    return callHandler(
      (request) => handlers.setBoard(request, args.projectId),
      { board: args.board },
    );
  },
});
