// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { laneIdArg } from "./shared.ts";
import { lanesService, laneService } from "./services.ts";

export const listLaneVersions = defineTool({
  name: "list_lane_versions",
  title: "List the versions of a lane",
  description:
    "Every saved version of a lane, the newest first: the number, when it was saved, who saved it (a user id) and its change note. Read one with `get_lane_version`, go back to one with `restore_lane_version`.",
  scope: "factory:read",
  action: "start_implementer_task",
  input: { laneId: laneIdArg },
  async handler(context, args) {
    const lane = await laneService(() =>
      context.services.use(lanesService).get(args.laneId),
    );
    return {
      laneId: lane.id,
      name: lane.name,
      currentVersion: lane.version,
      archivedAt: lane.archivedAt,
      versions: lane.versions,
    };
  },
});
