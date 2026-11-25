// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { laneAnswer, laneIdArg } from "./shared.ts";
import { lanesService, laneService } from "./services.ts";

export const archiveLane = defineTool({
  name: "archive_lane",
  title: "Archive a lane",
  description:
    "Archives a lane: it leaves the list, takes no new version and is not started again; its versions stay readable and its name is free again. Asking again answers the same. Owners and Admins only.",
  scope: "factory:control",
  action: "manage_workflows",
  input: { laneId: laneIdArg },
  async handler(context, args) {
    return laneAnswer(
      context,
      await laneService(() =>
        context.services.use(lanesService).archive(args.laneId),
      ),
    );
  },
});
