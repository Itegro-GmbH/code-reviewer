// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";
import {
  fleetService,
  namedRunnersService,
  NO_SUCH_RUNNER,
  runnerAnswer,
  runnerFleetService,
  statusById,
} from "./services.ts";

export const runnerIdArg = z
  .string()
  .min(1)
  .max(128)
  .describe("The id of the runner, as `list_runners` shows it.");

export const getRunner = defineTool({
  name: "get_runner",
  title: "Get a runner",
  description:
    "One runner by id (a hosted runner, a self-hosted one, or a revoked one, which answers `status: revoked`). A self-hosted runner also has its `manifest`: what the machine announces (harnesses, logins, models), which decides what a step on it can run.",
  scope: "factory:read",
  action: "start_implementer_task",
  input: { runnerId: runnerIdArg },
  async handler(context, args) {
    const runner = await context.services
      .use(namedRunnersService)
      .find(args.runnerId);
    if (runner === undefined) throw new ToolError("not_found", NO_SUCH_RUNNER);
    const status = await fleetService(() =>
      statusById(context.services.use(runnerFleetService)),
    );
    return { runner: runnerAnswer(runner, status, true) };
  },
});
