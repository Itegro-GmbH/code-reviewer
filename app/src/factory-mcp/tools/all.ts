// SPDX-License-Identifier: LicenseRef-Proprietary

// The tools of the running server: the groups of the slices of epic #1143, one file each (`groups/`). A slice adds its tools to ITS group
// file and never edits this one or another slice's group, so two slices never conflict. The registry refuses a name that is used twice.
import { orientationTools } from "./groups/orientation.ts";
import { projectAndLaneTools } from "./groups/projects-lanes.ts";
import { runAndTodoTools } from "./groups/runs-todos.ts";
import { runnerMcpAndModelTools } from "./groups/runners-mcp-models.ts";
import type { FactoryTool } from "./define.ts";

export const ALL_TOOLS: readonly FactoryTool[] = [
  ...orientationTools,
  ...projectAndLaneTools,
  ...runAndTodoTools,
  ...runnerMcpAndModelTools,
];
