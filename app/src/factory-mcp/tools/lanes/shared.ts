// SPDX-License-Identifier: LicenseRef-Proprietary

// What the lane tools share (#1145): the argument shapes and how a lane is answered.
import { z } from "zod";
import type { WorkflowView } from "../../../workflows/service.ts";
import type { ToolContext } from "../context.ts";
import { laneUrl } from "./services.ts";

export const laneIdArg = z
  .string()
  .min(1)
  .max(128)
  .describe("The id of the lane (workflow), as `list_lanes` shows it.");

export const projectIdArg = z
  .string()
  .min(1)
  .max(128)
  .describe("The id of the project the lane belongs to.");

/** A lane document is the JSON object `get_lane_schema` describes; the validator, not this schema, says what is wrong with it. */
export const documentArg = z
  .record(z.string(), z.unknown())
  .describe(
    "The whole lane document, a JSON object as `get_lane_schema` describes it (the same document `get_lane` returns).",
  );

export const changeDescriptionArg = z
  .string()
  .min(1)
  .max(1000)
  .describe(
    "1 to 1,000 characters saying what this version changes against the one before. Shown in the version list.",
  );

/** A lane as the tools answer it: the app's own view (summary, the document of one version, every saved version) and its address. */
export function laneAnswer(
  context: ToolContext,
  lane: WorkflowView,
): Record<string, unknown> {
  return { lane, url: laneUrl(context, lane.id) };
}
