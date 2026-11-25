// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { fleetService, runnerFleetService } from "./services.ts";

export const createRunnerToken = defineTool({
  name: "create_runner_token",
  title: "Create a runner registration token",
  description:
    "Makes a registration token for a new self-hosted runner. It is shown ONCE in this answer (the server keeps only its hash), valid for one hour and usable once: hand it to the person or the script that starts the runner, never write it into a lane or a file that is kept. A workspace may hold a limited number of unused tokens (`limit_reached` with the `maximum`). Owners and Admins only.",
  scope: "factory:control",
  action: "manage_runners",
  input: {},
  async handler(context) {
    const fleet = context.services.use(runnerFleetService);
    const created = await fleetService(() =>
      fleet.createToken({ id: context.user.id }),
    );
    return {
      token: created.token,
      expiresAt: created.expiresAt,
      singleUse: true,
      registerUrl: `${context.environment.baseUrl.replace(/\/+$/, "")}/api/runners/v1/register`,
    };
  },
});
