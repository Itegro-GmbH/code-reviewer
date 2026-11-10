// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/internal/dispatch-sweep: the sweep of a hosted deployment (lapsed leases, resends, the give-up, the hourly
// cleanup), called by the platform's cron every 2 hours (`vercel.json`, the safety net) in serverless mode (404 anywhere else).
// Public for the session guard: CRON_SECRET is the credential. All logic is in src/cron/ and src/dispatch/.
import { connection } from "next/server";
import { handleDispatchSweepCron } from "../../../../cron/dispatch-sweep.ts";
import { getDatabase } from "../../../../db/startup.ts";
import { getDispatchSweep } from "../../../../dispatch/sweep-shared.ts";
import { getQueuedFollowUpStarter } from "../../../../implementer/follow-up-shared.ts";

export async function GET(request: Request): Promise<Response> {
  await connection();
  return handleDispatchSweepCron(request, {
    env: process.env,
    db: getDatabase,
    // #841: the starter of the instructions queued while a turn ran is built here: only a route may import both.
    sweep: () =>
      getDispatchSweep(process.env, { followUps: getQueuedFollowUpStarter() }),
  });
}
