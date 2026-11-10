// SPDX-License-Identifier: LicenseRef-Proprietary

// The dispatch webhook of the running server: the hook the job queues of the request handlers get
// (src/jobs/shared.ts), and the service the sweep (#328) calls. Per request code asks for them here.
import "server-only";
import { after } from "next/server";
import type { EnqueueResult } from "../jobs/job-types.ts";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { createRunnerDispatchesRepository } from "../db/repositories/runner-dispatches-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { openDeliverySecret } from "../runner-identity/delivery.ts";
import { minimumBaseVersion } from "../runner-identity/config.ts";
import { DispatchConfigError, loadDispatchConfig } from "./config.ts";
import { createDispatchHook } from "./hook.ts";
import { createRingService, type RingService } from "./rings.ts";
import { createDispatchService, type DispatchService } from "./service.ts";
import { createStopService, type StopService } from "./stop.ts";

/**
 * Runs `work` after the response was sent (Next's `after()`, which a serverless platform keeps the function
 * alive for). Outside a request there is no response to wait for, and the work simply starts. It never
 * rejects, so nothing here can fail the caller either way.
 */
export function runAfterResponse(work: () => Promise<void>): void {
  const safe = () => work().catch(() => undefined);
  try {
    after(safe);
  } catch {
    void safe();
  }
}

/**
 * #972: the doorbell to the webhook dispatchers of customers, or undefined while the instance polls (no outgoing call is ever made then).
 * Throws `DispatchConfigError` for a bad webhook setup.
 */
export function getRingService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RingService | undefined {
  const config = loadDispatchConfig(env);
  if (config.mode === "poll") return undefined;
  return createRingService({
    db: getDatabase(),
    openSecret: (runnerId, sealed) => {
      const resolved = resolveAppSecret(env);
      // The server does not start without it (src/auth/startup.ts); this is the second line.
      if (!resolved.ok) throw new Error(resolved.problem);
      return openDeliverySecret(resolved.secret, runnerId, sealed);
    },
    minBaseVersion: () => minimumBaseVersion(env),
  });
}

type Env = Readonly<Record<string, string | undefined>>;

let invalidReported = false;

function ringServiceOrUndefined(env: Env): RingService | undefined {
  try {
    return getRingService(env);
  } catch (error) {
    // A bad setting turns the hook off with its own report (`createDispatchHook`); anything else is a code.
    if (error instanceof DispatchConfigError) return undefined;
    throw error;
  }
}

/** The hook for `createJobQueue`, or undefined while the instance polls (the default). */
export function dispatchHook(
  env: Env = process.env,
): ((result: EnqueueResult) => void) | undefined {
  return createDispatchHook({
    env,
    db: getDatabase(),
    schedule: runAfterResponse,
    rings: ringServiceOrUndefined(env),
    reportInvalid: (line) => {
      // Once per process: every enqueue would say it again.
      if (invalidReported) return;
      invalidReported = true;
      console.error(line);
    },
  });
}

/**
 * The service for the sweep (#328): `sendDue()` sends every queued job that is due and not yet called, or
 * whose call is due again. Undefined in poll mode. Throws `DispatchConfigError` for a bad webhook setup.
 */
export function getDispatchService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DispatchService | undefined {
  const config = loadDispatchConfig(env);
  if (config.mode === "poll") return undefined;
  return createDispatchService({ db: getDatabase(), config });
}

/**
 * #487: the stop call to the Dispatcher, or undefined while the instance polls (a self-hosted runner and Compose
 * never get one). Throws `DispatchConfigError` for a bad webhook setup.
 */
export function getStopService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StopService | undefined {
  const config = loadDispatchConfig(env);
  if (config.mode === "poll") return undefined;
  const db = getDatabase();
  const holders = createRunnerDispatchesRepository(db);
  return createStopService({
    db,
    config,
    // #972: a job held by a customer's webhook dispatcher is stopped there, with that dispatcher's own key.
    customerTarget: async (jobId) => {
      const holder = await holders.holderDelivery(jobId);
      if (holder === undefined) return undefined;
      const resolved = resolveAppSecret(env);
      if (!resolved.ok) return undefined;
      return {
        url: holder.url,
        key: {
          kid: holder.keyId,
          secret: openDeliverySecret(
            resolved.secret,
            holder.runnerId,
            holder.sealedSecret,
          ),
        },
      };
    },
  });
}

/**
 * #487: the claims of these jobs ended (a result, a failure, a cancel, a lapsed lease, a timeout): the Dispatcher is told
 * to stop their VMs, after the response, best effort. Never throws and never delays the call that ended the claims.
 */
export function stopEndedClaims(
  jobIds: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (jobIds.length === 0) return;
  try {
    const service = getStopService(env);
    if (service !== undefined) runAfterResponse(() => service.stopJobs(jobIds));
  } catch (error) {
    // A bad setting turns the stop off like the wake-up (the start check refuses it loudly); anything else is a code.
    if (!(error instanceof DispatchConfigError))
      console.error("[dispatch] DISPATCH_STOP_FAILED");
  }
}

/**
 * #972: the claims of these jobs ended: a slot freed in their label groups, so the waiting jobs those groups can take are rung again
 * (after the response, best effort, bounded). Never throws and never delays the call that ended the claims.
 */
export function ringEndedClaims(
  jobIds: readonly string[],
  env: Env = process.env,
): void {
  if (jobIds.length === 0) return;
  try {
    const rings = getRingService(env);
    if (rings !== undefined)
      runAfterResponse(async () => void (await rings.ringGroupsOf(jobIds)));
  } catch (error) {
    // A bad setting turns the ring off like the wake-up (the start check refuses it loudly); anything else is a code.
    if (!(error instanceof DispatchConfigError))
      console.error("[dispatch] RING_FAILED job=none");
  }
}

/**
 * #972: a lapsed lease (or a revoked runner) put these jobs back in the queue: the webhook dispatchers that can take them are rung at once,
 * and the label groups they were in (after the response, best effort, bounded). Never throws and never delays the call that requeued them.
 */
export function ringRequeuedJobs(
  jobIds: readonly string[],
  env: Env = process.env,
): void {
  if (jobIds.length === 0) return;
  try {
    const rings = getRingService(env);
    if (rings !== undefined)
      runAfterResponse(async () => void (await rings.ringRequeued(jobIds)));
  } catch (error) {
    // A bad setting turns the ring off like the wake-up (the start check refuses it loudly); anything else is a code.
    if (!(error instanceof DispatchConfigError))
      console.error("[dispatch] RING_FAILED job=none");
  }
}

export { DispatchConfigError };
