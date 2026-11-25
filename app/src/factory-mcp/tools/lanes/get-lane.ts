// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { laneAnswer, laneIdArg } from "./shared.ts";
import { lanesService, laneService } from "./services.ts";

export const getLane = defineTool({
  name: "get_lane",
  title: "Get a lane",
  description:
    "One lane with the document of its current version (or of `version`) and the list of all its versions with their change notes. The `document` is what `update_lane` takes back after you change it; its `version` is what you pass as `expectedVersion`.",
  scope: "factory:read",
  action: "start_implementer_task",
  input: {
    laneId: laneIdArg,
    version: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("An older version to read instead of the current one."),
  },
  async handler(context, args) {
    return laneAnswer(
      context,
      await laneService(() =>
        context.services.use(lanesService).get(args.laneId, args.version),
      ),
    );
  },
});
