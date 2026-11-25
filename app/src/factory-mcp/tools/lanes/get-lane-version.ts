// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { laneAnswer, laneIdArg } from "./shared.ts";
import { lanesService, laneService } from "./services.ts";

export const getLaneVersion = defineTool({
  name: "get_lane_version",
  title: "Get one version of a lane",
  description:
    "The document of one saved version of a lane (`lane.documentVersion` says which), with the lane's summary and version list. Use it to compare versions or to see what a `restore_lane_version` would bring back.",
  scope: "factory:read",
  action: "start_implementer_task",
  input: {
    laneId: laneIdArg,
    version: z.number().int().min(1).describe("The version number."),
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
