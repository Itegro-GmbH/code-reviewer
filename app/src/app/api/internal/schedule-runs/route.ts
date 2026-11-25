// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/internal/schedule-runs: the hourly tick that starts the runs of lanes with a schedule trigger (#1140), called by the platform's
// cron (`vercel.json`, `0 * * * *`). Public for the session guard: CRON_SECRET is the credential. A deployment without the factory
// answers `skipped`. All logic is in src/cron/schedule-runs.ts and src/workflow-runs/schedule-trigger.ts.
import { connection } from "next/server";
import { getCapabilities } from "../../../../capabilities/shared.ts";
import { handleScheduleRunsCron } from "../../../../cron/schedule-runs.ts";
import { scheduleRunnerFor } from "../../../../workflow-runs/shared.ts";

export async function GET(request: Request): Promise<Response> {
  await connection();
  return handleScheduleRunsCron(request, {
    env: process.env,
    enabled: () => getCapabilities().has("implementer"),
    runner: scheduleRunnerFor,
  });
}
