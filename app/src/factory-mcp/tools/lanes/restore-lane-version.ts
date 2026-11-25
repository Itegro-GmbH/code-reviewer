// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { laneAnswer, laneIdArg } from "./shared.ts";
import { lanesService, laneService } from "./services.ts";

export const restoreLaneVersion = defineTool({
  name: "restore_lane_version",
  title: "Restore an older version of a lane",
  description:
    "Brings an older version back by saving its document as a NEW version (history is never rewritten, so the restore can be undone too). The document is validated again against the workspace as it is now, so an old version that no longer passes (a runner or profile since removed) answers `invalid_input` with every problem. Owners and Admins only.",
  scope: "factory:control",
  action: "manage_workflows",
  input: {
    laneId: laneIdArg,
    version: z.number().int().min(1).describe("The version to bring back."),
    changeDescription: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe("The change note; `Restored version N` when left out."),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Save only if this is still the current version (otherwise `conflict`).",
      ),
  },
  async handler(context, args) {
    const lanes = context.services.use(lanesService);
    const old = await laneService(() => lanes.get(args.laneId, args.version));
    const document =
      typeof old.document === "object" &&
      old.document !== null &&
      !Array.isArray(old.document)
        ? old.document
        : {};
    return laneAnswer(
      context,
      await laneService(() =>
        lanes.update(
          { id: context.user.id },
          args.laneId,
          {
            ...document,
            changeDescription:
              args.changeDescription ?? `Restored version ${args.version}`,
          },
          args.expectedVersion,
        ),
      ),
    );
  },
});
