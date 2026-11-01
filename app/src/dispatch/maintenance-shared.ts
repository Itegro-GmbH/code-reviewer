// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of what happens between two sweeps on the running server (#395): the reaction to a job that ended and
// the repair work of the requests that touch the database. Both exist only while the dispatch webhook is on
// (`RUNNER_DISPATCH=webhook`); a polling instance has its runners and its timers. Per request code asks for them
// here, after its response was sent (`runAfterResponse`).
import "server-only";
import { getDatabase } from "../db/startup.ts";
import { OPPORTUNISTIC_LOCK, tryWithLock } from "../db/try-lock.ts";
import { getCapabilities } from "../capabilities/shared.ts";
import { getWriteTokens } from "../runner-api/claimed-keys-shared.ts";
import { getCheckRunService } from "../check-runs/shared.ts";
import { getRunnerQueue } from "../jobs/shared.ts";
import {
  createJobEndedReaction,
  type JobEndedEvent,
  type JobEndedReaction,
} from "./job-ended.ts";
import {
  createOpportunisticMaintenance,
  type OpportunisticMaintenance,
} from "./opportunistic.ts";
import {
  DispatchConfigError,
  getDispatchService,
  runAfterResponse,
} from "./shared.ts";
import { loadSweepSettings } from "./sweep-settings.ts";

type Env = Readonly<Record<string, string | undefined>>;

function serviceOrUndefined(env: Env) {
  try {
    return getDispatchService(env);
  } catch (error) {
    if (error instanceof DispatchConfigError) return undefined;
    throw error;
  }
}

/** The reaction to a job that ended, or undefined while the instance polls. */
export function getJobEndedReaction(
  env: Env = process.env,
): JobEndedReaction | undefined {
  const dispatch = serviceOrUndefined(env);
  if (dispatch === undefined) return undefined;
  const queue = getRunnerQueue();
  return createJobEndedReaction({
    dispatch,
    countRunning: () => queue.countRunning(),
    maxRunning: () => loadSweepSettings(env).maxRunning,
  });
}

/** Hands the end of a job to `getJobEndedReaction` after the response. Never throws. */
export function jobEnded(event: JobEndedEvent): void {
  try {
    const react = getJobEndedReaction();
    if (react !== undefined) runAfterResponse(() => react(event));
  } catch {
    console.error("[dispatch] JOB_ENDED_DISPATCH_FAILED");
  }
}

// One per process: it holds the time of its last run.
let maintenance: OpportunisticMaintenance | undefined;

function getMaintenance(env: Env): OpportunisticMaintenance | undefined {
  const dispatch = serviceOrUndefined(env);
  // Poll mode: no Dispatcher, and the long-lived server has its own timers.
  if (dispatch === undefined) return undefined;
  maintenance ??= createOpportunisticMaintenance({
    withLock: (work) => tryWithLock(getDatabase(), OPPORTUNISTIC_LOCK, work),
    queue: getRunnerQueue(),
    dispatch,
    checks: getCheckRunService(),
    ...(getCapabilities().has("implementer")
      ? { writeTokens: getWriteTokens() }
      : {}),
  });
  return maintenance;
}

/** A request touched the database: releases expired leases and sends what is due, after the response. Never throws. */
export function touched(env: Env = process.env): void {
  try {
    const work = getMaintenance(env);
    if (work !== undefined)
      runAfterResponse(async () => void (await work.run()));
  } catch {
    console.error("[dispatch] OPPORTUNISTIC_MAINTENANCE_FAILED");
  }
}
