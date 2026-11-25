// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { runnerIdArg } from "./get-runner.ts";
import { fleetService, runnerFleetService } from "./services.ts";

export const revokeRunner = defineTool({
  name: "revoke_runner",
  title: "Revoke a runner",
  description:
    "Revokes a self-hosted runner: its next call is refused and the job it is running ends. A lane step that names it is `runner_unknown` at the next save and `runner_not_found` for a run, so move such steps to another runner first (`update_lane`). A revoked runner cannot be undone: register a new one with `create_runner_token`. Hosted runners cannot be revoked. Owners and Admins only.",
  scope: "factory:control",
  action: "manage_runners",
  input: { runnerId: runnerIdArg },
  async handler(context, args) {
    await fleetService(() =>
      context.services.use(runnerFleetService).revoke(args.runnerId),
    );
    return { revoked: true, runnerId: args.runnerId };
  },
});
