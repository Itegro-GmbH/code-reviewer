// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import {
  laneSchemaOverview,
  laneSchemaSection,
  laneSchemaSectionNames,
} from "../../lane-schema/build.ts";
import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";

export const getLaneSchema = defineTool({
  name: "get_lane_schema",
  title: "How a lane is written",
  description:
    "Everything needed to write a lane (workflow) document the validator accepts. Without `section` it answers the overview: how to write one, the triggers, connectors, limits and the list of sections. With `section` it answers one part: `example`, `schema` (JSON Schema), `result_schema`, or a chapter of the format documentation such as `five-kinds-of-node` or `five-kinds-of-node/the-agent-step-kind-agent`.",
  scope: "factory:read",
  input: {
    section: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "A section name from the overview's `sections` list. Leave out for the overview.",
      ),
  },
  async handler(_context, { section }) {
    if (section === undefined) return laneSchemaOverview();
    const found = laneSchemaSection(section);
    if (found === undefined)
      throw new ToolError("not_found", `There is no section "${section}".`, {
        sections: laneSchemaSectionNames(),
      });
    return found;
  },
});
