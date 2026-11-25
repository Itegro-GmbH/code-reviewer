// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";
import { runnerIdArg } from "./get-runner.ts";
import {
  fleetService,
  namedRunnersService,
  NO_SUCH_RUNNER,
  runnerAnswer,
  runnerFleetService,
  statusById,
} from "./services.ts";

export const updateRunner = defineTool({
  name: "update_runner",
  title: "Rename a runner",
  description:
    "Gives a self-hosted runner another name (one line of 1 to 80 characters, free among the runners and the hosted runners of the workspace, case ignored). Lanes store the runner's id, so a rename breaks no lane. Hosted runners and revoked runners cannot be renamed. Owners and Admins only.",
  scope: "factory:control",
  action: "manage_runners",
  input: {
    runnerId: runnerIdArg,
    name: z.string().min(1).max(200).describe("The new name."),
  },
  async handler(context, args) {
    const named = context.services.use(namedRunnersService);
    const fleet = context.services.use(runnerFleetService);
    const before = await named.find(args.runnerId);
    if (before === undefined) throw new ToolError("not_found", NO_SUCH_RUNNER);
    if (before.kind === "hosted")
      throw new ToolError(
        "invalid_input",
        "A hosted runner has a fixed name; only a self-hosted runner can be renamed.",
      );
    if (before.revokedAt !== null)
      throw new ToolError("conflict", "A revoked runner cannot be renamed.");
    await fleetService(() => fleet.rename(args.runnerId, args.name));
    const after = await named.find(args.runnerId);
    if (after === undefined) throw new ToolError("not_found", NO_SUCH_RUNNER);
    return {
      runner: runnerAnswer(
        after,
        await fleetService(() => statusById(fleet)),
        false,
      ),
    };
  },
});
