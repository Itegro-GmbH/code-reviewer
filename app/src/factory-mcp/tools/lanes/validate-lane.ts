// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { documentArg } from "./shared.ts";
import { lanesService, laneService } from "./services.ts";

export const validateLane = defineTool({
  name: "validate_lane",
  title: "Validate a lane document",
  description:
    "Checks a lane document against the format and this workspace's runners, profiles, environments, models and agent MCP servers, and stores nothing. A document with problems is a normal answer: `valid: false` and `errors`, every problem with its JSON pointer `path`, a `code`, a `message` and the names that were `available`; `warnings` do not stop a save. Use it before `create_lane` or `update_lane`.",
  scope: "factory:read",
  action: "start_implementer_task",
  input: { document: documentArg },
  async handler(context, args) {
    return {
      ...(await laneService(() =>
        context.services.use(lanesService).validate(args.document),
      )),
    };
  },
});
