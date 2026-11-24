// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/internal/schedule-runs, called once an hour by the platform's cron (`vercel.json`; #1140): the lanes whose schedule trigger is due
// start a run (`src/workflow-runs/schedule-trigger.ts`, which this only calls). The schedule is read in UTC and the tick is hourly, so a
// lane starts at the first tick at or after its time (`30 6 * * 0` at 07:00); a missed tick is made up by the next one, once.
//
//  - `CRON_SECRET` is the whole credential (`src/cron/auth.ts`); a refused call opens no connection.
//  - A deployment without the factory (`implementer`) touches nothing and answers `skipped`.
//  - Overlapping and retried calls are safe: a run is written under a request id of the lane, the trigger and the occurrence, so a second
//    call finds the run of the first (`existing`) and writes none. No lock is needed.
//  - One lane's failure never stops the others; the runner logs each by id and code. The answer carries counts only.
import "server-only";
import type {
  ScheduleRunner,
  ScheduleTickResult,
} from "../workflow-runs/schedule-trigger.ts";
import { refuseUnlessCron } from "./auth.ts";

export const SCHEDULE_RUNS_CRON_ERROR_CODES = [
  "SCHEDULE_RUNS_CRON_FAILED",
] as const;

export type ScheduleRunsCronDependencies = {
  env: Readonly<Record<string, string | undefined>>;
  enabled(): boolean;
  /** Made only for a caller that holds the secret. */
  runner(): ScheduleRunner;
};

export type ScheduleRunsCronAnswer =
  | ({ status: "ok" } & ScheduleTickResult)
  | { status: "skipped"; reason: "not_enabled" }
  | { status: "error"; code: "SCHEDULE_RUNS_CRON_FAILED" };

export async function handleScheduleRunsCron(
  request: Request,
  deps: ScheduleRunsCronDependencies,
): Promise<Response> {
  const refusal = refuseUnlessCron(request, deps.env);
  if (refusal !== null) return refusal;
  const headers = { "cache-control": "no-store" };
  if (!deps.enabled())
    return Response.json(
      {
        status: "skipped",
        reason: "not_enabled",
      } satisfies ScheduleRunsCronAnswer,
      { headers },
    );
  try {
    const result = await deps.runner().run();
    return Response.json(
      { status: "ok", ...result } satisfies ScheduleRunsCronAnswer,
      {
        headers,
      },
    );
  } catch {
    // The cause is not repeated: it may carry a connection string.
    console.error(
      "[schedule] SCHEDULE_RUNS_CRON_FAILED: the tick could not list the scheduled lanes.",
    );
    return Response.json(
      {
        status: "error",
        code: "SCHEDULE_RUNS_CRON_FAILED",
      } satisfies ScheduleRunsCronAnswer,
      { status: 500, headers },
    );
  }
}
