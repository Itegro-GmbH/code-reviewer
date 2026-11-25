// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { documentArg, laneAnswer, projectIdArg } from "./shared.ts";
import { lanesService, laneService } from "./services.ts";

export const createLane = defineTool({
  name: "create_lane",
  title: "Create a lane",
  description:
    "Saves a new lane in a project as version 1. The `document` must pass the validator (run `validate_lane` first) and carry a `description` of what the lane does. A document with problems answers `invalid_input` listing every one in `errors`; a name the project already has is `conflict`. Owners and Admins only.",
  scope: "factory:control",
  action: "manage_workflows",
  input: { projectId: projectIdArg, document: documentArg },
  async handler(context, args) {
    return laneAnswer(
      context,
      await laneService(() =>
        context.services
          .use(lanesService)
          .create({ id: context.user.id }, args.projectId, args.document),
      ),
    );
  },
});
