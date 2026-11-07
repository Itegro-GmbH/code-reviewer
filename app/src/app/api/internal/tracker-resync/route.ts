// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/internal/tracker-resync: the nightly full sync of the ticket mirror for every active project (#932), called by the platform's
// cron in serverless mode. Public for the session guard: CRON_SECRET is the credential. A deployment without the factory answers
// `skipped`. All logic is in src/cron/.
import { connection } from "next/server";
import { getCapabilities } from "../../../../capabilities/shared.ts";
import { handleTrackerResyncCron } from "../../../../cron/tracker-resync.ts";
import {
  resyncTargets,
  trackerServiceFor,
} from "../../../../tracker/shared.ts";

export async function GET(request: Request): Promise<Response> {
  await connection();
  return handleTrackerResyncCron(request, {
    env: process.env,
    enabled: () => getCapabilities().has("implementer"),
    targets: resyncTargets,
    resync: (target, deadline, signal) =>
      // The nights of one sync are a day apart: continue what an earlier night left (`resume`), do not start it again.
      trackerServiceFor(target.workspaceId).sync(target.repositoryId, {
        deadline,
        signal,
        resume: true,
      }),
  });
}
