// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";
import { costsService } from "./services.ts";

export const getCosts = defineTool({
  name: "get_costs",
  title: "Get the costs",
  description:
    "The balance journal of the workspace, newest first: top-ups, start credit, usage charges (each with the run it was for and its AI and infrastructure part, final prices in micro-dollars, 1 USD = 1,000,000) and refunds. Page with `cursor` (`next` of the previous answer). Only while billing is on; otherwise `billingEnabled: false` and the cost of a single run is `spentUsd` in `get_run`. Read only.",
  scope: "factory:read",
  input: {
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe("The `next` of the previous page."),
  },
  async handler(context, args) {
    const costs = context.services.use(costsService);
    if (!(await costs.billingOn()))
      return { billingEnabled: false, rows: [], next: null };
    const result = await costs.billing().journal(
      {
        workspaceId: context.workspace.id,
        userId: context.user.id,
        role: context.role,
      },
      { cursor: args.cursor, limit: args.limit },
    );
    if (!result.ok)
      throw new ToolError(
        result.error === "forbidden" ? "forbidden" : "invalid_input",
        result.error === "forbidden"
          ? "The role does not allow reading the journal."
          : "The cursor or the limit is not valid; use the `next` of the previous page.",
      );
    return {
      billingEnabled: true,
      rows: result.page.rows,
      next: result.page.next,
    };
  },
});
