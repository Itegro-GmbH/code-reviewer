// SPDX-License-Identifier: LicenseRef-Proprietary

// Slice #1145 (projects and lanes): list_projects, get_project, create_project, update_project, archive_project, list_lanes, get_lane,
// validate_lane, create_lane, update_lane, list_lane_versions, get_lane_version, restore_lane_version, archive_lane.
// Each tool is a file of its own below `../projects/` and `../lanes/`; this file only lists them, and no other slice edits it.
import type { FactoryTool } from "../define.ts";
import { archiveLane } from "../lanes/archive-lane.ts";
import { createLane } from "../lanes/create-lane.ts";
import { getLane } from "../lanes/get-lane.ts";
import { getLaneVersion } from "../lanes/get-lane-version.ts";
import { listLaneVersions } from "../lanes/list-lane-versions.ts";
import { listLanes } from "../lanes/list-lanes.ts";
import { restoreLaneVersion } from "../lanes/restore-lane-version.ts";
import { updateLane } from "../lanes/update-lane.ts";
import { validateLane } from "../lanes/validate-lane.ts";
import { archiveProject } from "../projects/archive-project.ts";
import { createProject } from "../projects/create-project.ts";
import { getProject } from "../projects/get-project.ts";
import { listProjects } from "../projects/list-projects.ts";
import { updateProject } from "../projects/update-project.ts";

export const projectAndLaneTools: readonly FactoryTool[] = [
  listProjects,
  getProject,
  createProject,
  updateProject,
  archiveProject,
  listLanes,
  getLane,
  validateLane,
  createLane,
  updateLane,
  listLaneVersions,
  getLaneVersion,
  restoreLaneVersion,
  archiveLane,
];
