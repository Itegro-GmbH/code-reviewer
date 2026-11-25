// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";
import { applyEdits } from "./edits.ts";
import {
  changeDescriptionArg,
  documentArg,
  laneAnswer,
  laneIdArg,
} from "./shared.ts";
import { lanesService, laneService } from "./services.ts";

export const updateLane = defineTool({
  name: "update_lane",
  title: "Save a new version of a lane",
  description:
    'Saves a new version of a lane; versions are never changed, so every save can be undone with `restore_lane_version`. Give EITHER the whole changed `document` OR `edits`: a list of `{ path, value }` changes (JSON pointer into the current document, `value` omitted to remove) applied to the version you name in `expectedVersion`, for example `{ "path": "/steps/1/runner", "value": "<runner id>" }` or `{ "path": "/steps/1/harness", "value": "claude-code" }` (a runner id that does not exist answers `invalid_input` with the ids that do in `available`). `changeDescription` is required. The result is validated first: problems answer `invalid_input` with every one in `errors` and nothing is saved. Pass `expectedVersion` (the `version` from `get_lane`) so a save over someone else\'s is `conflict` with the `current` version. Owners and Admins only.',
  scope: "factory:control",
  action: "manage_workflows",
  input: {
    laneId: laneIdArg,
    changeDescription: changeDescriptionArg,
    document: documentArg.optional(),
    edits: z
      .array(
        z.object({
          path: z
            .string()
            .max(500)
            .describe(
              "A JSON pointer into the lane document, such as `/steps/0/runner`. `/-` at the end of an array path appends.",
            ),
          value: z
            .unknown()
            .optional()
            .describe("The new value; leave out to remove the key or entry."),
        }),
      )
      .min(1)
      .max(100)
      .optional(),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Save only if this is still the current version. Required with `edits`: they change that version.",
      ),
  },
  async handler(context, args) {
    if ((args.document === undefined) === (args.edits === undefined))
      throw new ToolError(
        "invalid_input",
        "Give either `document` or `edits`, not both and not neither.",
      );
    const lanes = context.services.use(lanesService);
    let document = args.document;
    if (document === undefined) {
      if (args.expectedVersion === undefined)
        throw new ToolError(
          "invalid_input",
          "`edits` change one version of the lane: pass `expectedVersion`, the version you read.",
        );
      const base = await laneService(() =>
        lanes.get(args.laneId, args.expectedVersion),
      );
      document = applyEdits(base.document, args.edits ?? []);
    }
    return laneAnswer(
      context,
      await laneService(() =>
        lanes.update(
          { id: context.user.id },
          args.laneId,
          { ...document, changeDescription: args.changeDescription },
          args.expectedVersion,
        ),
      ),
    );
  },
});
