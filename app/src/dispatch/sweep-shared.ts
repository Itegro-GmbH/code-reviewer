// SPDX-License-Identifier: LicenseRef-Proprietary

// The sweep of the running server (#328): the real database, queue, dispatch service and settings from the
// environment. The route (src/app/api/internal/dispatch-sweep) only calls this.
import "server-only";
import { getCapabilities } from "../capabilities/shared.ts";
import { createAppMetaRepository } from "../db/repositories/app-meta-repository.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getCheckRunService } from "../check-runs/shared.ts";
import { getRunnerQueue } from "../jobs/shared.ts";
import { deliverDueBalanceMailsNow } from "../billing/shared.ts";
import { runJournalCheckWhileBillingOn } from "../billing/journal-check.ts";
import { releaseStrandedHoldsWhileBillingOn } from "../billing/stranded-holds.ts";
import { getWriteTokens } from "../runner-api/claimed-keys-shared.ts";
import { cleanUpExpiredRows } from "../maintenance/cleanup.ts";
import { getMailSender } from "../mail/shared.ts";
import { getModelsDevService } from "../models-dev/shared.ts";
import { getRefusalNoticeService } from "../refusal-notices/shared.ts";
import { DispatchConfigError, getDispatchService } from "./shared.ts";
import { createDispatchSweep, type DispatchSweep } from "./sweep.ts";
import { loadSweepSettings } from "./sweep-settings.ts";

export function getDispatchSweep(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DispatchSweep {
  const db = getDatabase();
  const capabilities = getCapabilities(env);
  let dispatch: ReturnType<typeof getDispatchService>;
  try {
    dispatch = getDispatchService(env);
  } catch (error) {
    if (!(error instanceof DispatchConfigError)) throw error;
    // The sweep still expires leases and gives up on stale jobs; it sends nothing until the settings are fixed.
    console.error(
      `[dispatch] ${error.code}: the sweep sends nothing until the dispatch settings are fixed.`,
    );
  }
  return createDispatchSweep({
    queue: getRunnerQueue(),
    dispatches: createJobDispatchesRepository(db),
    ...(dispatch === undefined ? {} : { dispatch }),
    meta: createAppMetaRepository(db),
    // #281: the notices of refused reviews whose post failed.
    notices: getRefusalNoticeService(),
    // #405: the check runs and review verdicts of the jobs the steps before ended or no request named.
    checks: getCheckRunService(),
    // #790: the write tokens of ended turns of the Implementer that could not be switched off are tried again.
    ...(capabilities.has("implementer")
      ? { writeTokens: getWriteTokens() }
      : {}),
    // #548: the daily fetch of the models.dev catalog, last.
    modelsDev: getModelsDevService(),
    // #591: the holds of jobs that ended while billing was off, while billing is on.
    billingHolds: {
      releaseStranded: () =>
        releaseStrandedHoldsWhileBillingOn(db, () => new Date()),
    },
    // #506: the balance mails that a settlement of this sweep left due.
    balanceMails: { deliverDue: deliverDueBalanceMailsNow },
    // #626: the daily check of the billing journal, while billing is on.
    journalCheck: { run: () => runJournalCheckWhileBillingOn(db) },
    cleanup: () =>
      cleanUpExpiredRows(db, undefined, {
        // Read when it matters, never remembered: the admin can add or remove the mail server at any time.
        mailConfigured: () => getMailSender().isConfigured(),
      }),
    settings: loadSweepSettings(env),
    // #731: the steps of a capability this deployment does not have are not run.
    capabilities,
  });
}
