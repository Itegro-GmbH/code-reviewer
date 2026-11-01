// SPDX-License-Identifier: LicenseRef-Proprietary

// One run of the cron sweep of a hosted deployment (#328). In a serverless deployment nothing polls and no
// process lives long enough to hold a timer, so the clock is this run, called once a minute by the platform's
// cron (src/cron/dispatch-sweep.ts, which also makes sure two runs never overlap). Per run, in this order:
//
//  1. `expire`: lapsed leases put back in the queue (or failed on the last attempt), jobs past the hard limit
//     failed with `timeout`: what a claim does first, for a deployment in which nobody claims often.
//  2. `give_up`: a job that has waited for a claim longer than the give-up time fails with
//     `dispatch_unavailable`, so a queued review never waits for ever when the Dispatcher is gone. Off in poll
//     mode unless the operator sets `RUNNER_DISPATCH_GIVE_UP_SECONDS` (settings.ts).
//  3. `revive`: a dispatch that the Dispatcher stopped (`not_capable`) is looked at again after
//     `STOPPED_REVIVE_MS`: the Dispatcher may have been updated or its engines may be back.
//  4. `send`: the jobs that are due and not yet called, or whose call is due again, within the pool cap
//     (`RUNNER_DISPATCH_MAX_RUNNING`): at most as many as there are free slots.
//  5. `notices`: the notices of refused reviews whose post failed and whose wait is over (#281), at most one
//     batch, each tried a few times at most.
//  6. `checks`: the check runs and review verdicts of jobs whose GitHub state is behind (#405): jobs the steps above
//     ended or requeued, jobs no request named, syncs whose retry is due. At most one batch, within a time budget.
//  7. `cleanup`: the hourly cleanup a long-lived server runs on a timer, once when the hour has changed.
//  8. `billing_holds`: while billing is on, releases the holds of jobs that ended while it was off (#591), once more than the
//     switch-on did. A job that ended in the moment billing was switched on is not seen by the switch-on; this finds it.
//  9. `balance_mails`: mails the balance crossings that are due (#506): a settlement of this sweep (an expired lease, a stranded
//     hold) or of a superseded job has no response to send after, so the mail would wait for the next claim or webhook. While
//     billing is off it reads the switch and does nothing. It never throws; a step that fails is named like any other.
// 10. `journal_check`: while billing is on, the daily check of the billing journal (#626): `verify()` of every workspace's journal, a
//     bounded step of the pass per run (src/billing/journal-check.ts). The result is kept in an instance setting, which the admin
//     billing page shows, and an inconsistency is logged by a stable code. Once a day it does real work; in the other runs it reads one
//     instance setting, and while billing is off nothing but the switch.
// 11. `models_dev`: the daily fetch of the models.dev catalog (#548), when the last one is more than a day old. Last, so
//     that a slow answer from the internet never delays the steps that move jobs. A fetch that fails records its own
//     failure (`models_dev_fetch_state`) and is not a failed step; a step fails only when the fetch itself threw.
//
// The capability set of the deployment (src/capabilities/) decides which steps exist: without `review` there are no jobs and the
// steps 1 to 6 do not run; without `billing` the steps 8 to 10 do not run (nothing of billing is read or asked). Steps 7 and 11
// belong to every deployment. Left out, the set is the whole product, as before.
//
// A step that fails is logged by its name and does not stop the others; the next run tries again. Nothing a
// database or an answer said is ever logged: a connection string can be in it.
import "server-only";
import type { CapabilitySet } from "../capabilities/capability.ts";
import type { AppMetaRepository } from "../db/repositories/app-meta-repository.ts";
import type { JobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import type { ExpiryReport } from "../db/repositories/runner-jobs-repository.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import type { CleanupResult } from "../maintenance/cleanup.ts";
import type { RefreshOutcome } from "../models-dev/service.ts";
import { DEFAULT_SEND_LIMIT, type DispatchService } from "./service.ts";

/** How long a stopped dispatch rests before the Dispatcher is asked about it again. */
export const STOPPED_REVIVE_MS = 10 * 60 * 1000;

/** Where the hour of the last cleanup is kept, so that every instance sees the same one. */
export const CLEANUP_HOUR_KEY = "maintenance.sweep_cleanup_hour";
const HOUR_MS = 60 * 60 * 1000;
/** The sweep runs in an internal route (five minutes), so the check runs may have most of a minute (#405). */
export const CHECKS_BUDGET_MS = 40_000;
/**
 * The deadline of the models.dev run: the fetch, the lookups and the write together (#548). The route has 300 seconds; the
 * check runs take 40 of them at most, the other steps are single queries and calls with limits of their own, and this
 * leaves the rest as headroom. A run that needs longer fails with `models_dev_timeout`, writes nothing and is tried again.
 */
export const MODELS_DEV_BUDGET_MS = 90_000;

export const SWEEP_STEPS = [
  "expire",
  "give_up",
  "revive",
  "send",
  "notices",
  "checks",
  "write_tokens",
  "cleanup",
  "billing_holds",
  "balance_mails",
  "journal_check",
  "models_dev",
] as const;
export type SweepStep = (typeof SWEEP_STEPS)[number];

export type SweepSettings = {
  /** Fail a job that waited this long for a claim; null: never. */
  giveUpMs: number | null;
  /** The pool cap: send no more than there are free slots below it; null: no cap on the app's side. */
  maxRunning: number | null;
};

export type SweepReport = {
  expired: ExpiryReport | null;
  givenUp: number;
  revived: number;
  sent: number;
  /** How many notices of refused reviews were tried again (#281). */
  noticesTried: number;
  /** How many jobs had their check run or review verdict synced with GitHub (#405). */
  checksSynced: number;
  cleanedUp: boolean;
  /** How many holds of ended jobs were released (#591); 0 while billing is off. */
  holdsReleased: number;
  /** How many balance mails were sent (#506); 0 while billing is off. */
  balanceMailsSent: number;
  /** How many workspaces had their journal checked in this run (#626); 0 while billing is off and between two daily passes. */
  journalChecked: number;
  /** What the daily models.dev fetch did (#548); null when this sweep has no fetch. */
  modelsDev: RefreshOutcome["status"] | null;
  /** The steps that failed in this run. */
  failedSteps: SweepStep[];
};

export type SweepLog = Pick<Console, "info" | "error">;

export type SweepDependencies = {
  now?: () => Date;
  queue: Pick<
    RunnerQueue,
    "expireStaleJobs" | "failUndispatched" | "countRunning"
  >;
  dispatches: Pick<JobDispatchesRepository, "reviveStopped">;
  /** Absent in poll mode: nothing is sent and no row is revived. */
  dispatch?: Pick<DispatchService, "sendDue">;
  meta: Pick<AppMetaRepository, "get" | "set">;
  cleanup: () => Promise<CleanupResult>;
  /** #281: tries the notices of refused reviews that are due again. Left out, none is tried. */
  notices?: { retryDue(): Promise<{ tried: number }> };
  /** #405: brings the check runs and verdicts of jobs in line with GitHub. Left out, none is touched. */
  checks?: {
    reconcileDue(options?: { budgetMs?: number }): Promise<{ synced: number }>;
  };
  /** #790: tries again to switch off the write tokens of ended turns that could not be switched off. Left out, none is tried. */
  writeTokens?: { retryPending(): Promise<void> };
  /** #591: releases the holds of ended jobs while billing is on (the step reads only the switch while it is off). Left out, none is. */
  billingHolds?: { releaseStranded(): Promise<{ released: number }> };
  /** #506: mails the balance crossings that are due (reads only the switch while billing is off). Left out, none is. */
  balanceMails?: {
    deliverDue(): Promise<{ delivered: number; failed: number }>;
  };
  /** #626: the daily check of the billing journal (reads only the switch while billing is off). Left out, none is made. */
  journalCheck?: { run(): Promise<{ checked: number }> };
  /** #548: the daily fetch of the models.dev catalog. Left out, none is made. */
  modelsDev?: {
    refreshIfDue(options?: { deadlineMs?: number }): Promise<RefreshOutcome>;
  };
  settings: SweepSettings;
  /** #731: which steps this deployment has. Left out, all of them. */
  capabilities?: CapabilitySet;
  log?: SweepLog;
};

export type DispatchSweep = { run(): Promise<SweepReport> };

export function createDispatchSweep(deps: SweepDependencies): DispatchSweep {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;
  const has = (capability: Parameters<CapabilitySet["has"]>[0]) =>
    deps.capabilities?.has(capability) ?? true;

  async function run(): Promise<SweepReport> {
    const report: SweepReport = {
      expired: null,
      givenUp: 0,
      revived: 0,
      sent: 0,
      noticesTried: 0,
      checksSynced: 0,
      cleanedUp: false,
      holdsReleased: 0,
      balanceMailsSent: 0,
      journalChecked: 0,
      modelsDev: null,
      failedSteps: [],
    };
    const step = async (name: SweepStep, work: () => Promise<void>) => {
      try {
        await work();
      } catch {
        report.failedSteps.push(name);
        log.error(`[sweep] SWEEP_STEP_FAILED step=${name}`);
      }
    };

    const review = has("review");
    if (review)
      await step("expire", async () => {
        report.expired = await deps.queue.expireStaleJobs();
      });
    const { giveUpMs, maxRunning } = deps.settings;
    if (review && giveUpMs !== null)
      await step("give_up", async () => {
        report.givenUp = await deps.queue.failUndispatched(giveUpMs);
      });
    const dispatch = review ? deps.dispatch : undefined;
    if (dispatch !== undefined) {
      await step("revive", async () => {
        const at = now();
        report.revived = await deps.dispatches.reviveStopped(
          new Date(at.getTime() - STOPPED_REVIVE_MS),
          at,
        );
      });
      await step("send", async () => {
        const free =
          maxRunning === null
            ? DEFAULT_SEND_LIMIT
            : Math.min(
                DEFAULT_SEND_LIMIT,
                maxRunning - (await deps.queue.countRunning()),
              );
        if (free > 0) report.sent = (await dispatch.sendDue(free)).sent;
      });
    }
    const notices = review ? deps.notices : undefined;
    if (notices !== undefined)
      await step("notices", async () => {
        report.noticesTried = (await notices.retryDue()).tried;
      });
    const checks = review ? deps.checks : undefined;
    if (checks !== undefined)
      await step("checks", async () => {
        report.checksSynced = (
          await checks.reconcileDue({ budgetMs: CHECKS_BUDGET_MS })
        ).synced;
      });
    const writeTokens = has("implementer") ? deps.writeTokens : undefined;
    if (writeTokens !== undefined)
      await step("write_tokens", async () => {
        await writeTokens.retryPending();
      });
    await step("cleanup", async () => {
      const hour = Math.floor(now().getTime() / HOUR_MS);
      const done = Number(await deps.meta.get(CLEANUP_HOUR_KEY));
      if (Number.isInteger(done) && done >= hour) return;
      await deps.cleanup();
      await deps.meta.set(CLEANUP_HOUR_KEY, String(hour));
      report.cleanedUp = true;
    });
    const billing = has("billing");
    const billingHolds = billing ? deps.billingHolds : undefined;
    if (billingHolds !== undefined)
      await step("billing_holds", async () => {
        report.holdsReleased = (await billingHolds.releaseStranded()).released;
      });
    const balanceMails = billing ? deps.balanceMails : undefined;
    if (balanceMails !== undefined)
      await step("balance_mails", async () => {
        report.balanceMailsSent = (await balanceMails.deliverDue()).delivered;
      });
    const journalCheck = billing ? deps.journalCheck : undefined;
    if (journalCheck !== undefined)
      await step("journal_check", async () => {
        report.journalChecked = (await journalCheck.run()).checked;
      });
    const modelsDev = deps.modelsDev;
    if (modelsDev !== undefined)
      await step("models_dev", async () => {
        report.modelsDev = (
          await modelsDev.refreshIfDue({ deadlineMs: MODELS_DEV_BUDGET_MS })
        ).status;
      });

    const expired = report.expired;
    const changed =
      (expired !== null &&
        expired.requeued +
          expired.leaseExpired +
          expired.timedOut +
          expired.noCapableRunner >
          0) ||
      report.givenUp + report.revived + report.sent > 0;
    if (changed)
      log.info(
        `[sweep] requeued=${String(expired?.requeued ?? 0)} lease_expired=${String(expired?.leaseExpired ?? 0)} timed_out=${String(expired?.timedOut ?? 0)} given_up=${String(report.givenUp)} revived=${String(report.revived)} sent=${String(report.sent)}`,
      );
    return report;
  }

  return { run };
}
