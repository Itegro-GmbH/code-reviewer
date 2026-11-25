// SPDX-License-Identifier: LicenseRef-Proprietary

// Slice #1145 (projects and lanes): list_projects, get_project, create_project, update_project, archive_project, list_lanes, get_lane,
// validate_lane, create_lane, update_lane, list_lane_versions, get_lane_version, restore_lane_version, archive_lane.
// Each tool is a file of its own below `../projects/` and `../lanes/`; this file only lists them, and no other slice edits it.
import type { FactoryTool } from "../define.ts";

export const projectAndLaneTools: readonly FactoryTool[] = [];
