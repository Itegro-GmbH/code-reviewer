// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server behind the runners page and routes (#854): the real database and environment. The capability
// check (`requireImplementerCapability`) is the Implementer's, in `../implementer/shared.ts`; the runners are part of it.
import "server-only";
import { createRunnersRepository } from "../db/repositories/runners-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getRunnerQueue } from "../jobs/shared.ts";
import {
  minimumBaseVersion,
  ONLINE_WITHIN_SECONDS,
} from "../runner-identity/config.ts";
import type { OnlineRunner } from "../runner-identity/announced.ts";
import {
  createRunnerFleetService,
  onlineRunnersOf,
  type RunnerFleetService,
} from "./service.ts";

/** #973: the runners of one workspace that are online now and what each announces, for the validator of profiles and workflows. */
export function onlineRunnersFor(
  workspaceId: string,
): () => Promise<OnlineRunner[]> {
  const runners = createRunnersRepository(getDatabase(), workspaceId);
  return () =>
    onlineRunnersOf(
      runners,
      {
        minBaseVersion: minimumBaseVersion(process.env),
        onlineWithinSeconds: ONLINE_WITHIN_SECONDS,
      },
      new Date(),
    );
}

/** The runner fleet service of one workspace. */
export function runnerFleetServiceFor(workspaceId: string): RunnerFleetService {
  return createRunnerFleetService({
    runners: createRunnersRepository(getDatabase(), workspaceId),
    endClaimsOf: async (customerRunnerId) => {
      await getRunnerQueue().expireClaimsOf(customerRunnerId);
    },
    settings: () => ({
      minBaseVersion: minimumBaseVersion(process.env),
      onlineWithinSeconds: ONLINE_WITHIN_SECONDS,
    }),
  });
}
