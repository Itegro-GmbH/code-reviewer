// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server behind the runners page and routes (#854): the real database and environment. The capability
// check (`requireImplementerCapability`) is the Implementer's, in `../implementer/shared.ts`; the runners are part of it.
import "server-only";
import { createRunnersRepository } from "../db/repositories/runners-repository.ts";
import { getDatabase } from "../db/startup.ts";
import {
  minimumBaseVersion,
  ONLINE_WITHIN_SECONDS,
} from "../runner-identity/config.ts";
import {
  createRunnerFleetService,
  type RunnerFleetService,
} from "./service.ts";

/** The runner fleet service of one workspace. */
export function runnerFleetServiceFor(workspaceId: string): RunnerFleetService {
  return createRunnerFleetService({
    runners: createRunnersRepository(getDatabase(), workspaceId),
    settings: () => ({
      minBaseVersion: minimumBaseVersion(process.env),
      onlineWithinSeconds: ONLINE_WITHIN_SECONDS,
    }),
  });
}
