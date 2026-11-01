// SPDX-License-Identifier: LicenseRef-Proprietary

// The queues of the running server, on the connection opened at start. Per request code (the webhook
// route, the runner API, the pages) asks for them here; tests build their own with `createJobQueue`
// and `createRunnerQueue`.
import "server-only";
import { getCapabilities } from "../capabilities/shared.ts";
import { getDatabase } from "../db/startup.ts";
import { checkNotifier } from "../check-runs/shared.ts";
import {
  notifyingJobQueue,
  notifyingRunnerQueue,
} from "../check-runs/notifying-queues.ts";
import {
  dispatchHook,
  runAfterResponse,
  stopEndedClaims,
} from "../dispatch/shared.ts";
import { getWriteTokens } from "../runner-api/claimed-keys-shared.ts";
import { endedClaimsReaction } from "../runner-api/write-token.ts";
import { deliverBalanceMails, recordWallClocks } from "../billing/shared.ts";
import { createJobQueue, type JobQueue } from "./job-queue.ts";
import { configuredNoCapableRunnerMs } from "../db/job-limits.ts";
import { noticeOfRefusal } from "../refusal-notices/shared.ts";
import { unknownCostAlertLine } from "../usage/unknown-cost-alert.ts";
import { createRunnerQueue, type RunnerQueue } from "./runner-queue.ts";

/**
 * The queue of one workspace. Every producer (the GitHub webhook, a comment, the start button) gets its
 * queue here, so each of them wakes the Dispatcher after it queued a job when `RUNNER_DISPATCH=webhook`
 * (#326); by default there is no hook and nothing changes.
 */
export function jobQueueFor(workspaceId: string): JobQueue {
  const dispatch = dispatchHook();
  const checks = notifyingJobQueue.onEnqueued(checkNotifier);
  // Both hooks run after the enqueue committed, and neither may keep the other from running.
  const onEnqueued: NonNullable<
    Parameters<typeof createJobQueue>[2]
  >["onEnqueued"] = (result) => {
    try {
      dispatch?.(result);
    } finally {
      checks(result);
    }
  };
  // #405: a waiting job that was dropped changes what GitHub should show: the check run is completed after it.
  // #731: a job of a review kind this deployment has no capability for is never queued.
  const capabilities = getCapabilities();
  return notifyingJobQueue(
    createJobQueue(getDatabase(), workspaceId, {
      onEnqueued,
      kindAllowed: (kind) => capabilities.allowsReviewKind(kind),
    }),
    checkNotifier,
  );
}

/** The workspaces whose ignored cost limit was logged already (#277): once per workspace and process is enough. */
const ignoredCostLimitLogged = new Set<string>();

/**
 * The queue as runners use it: one for the whole instance, every workspace. #405: it tells the check run
 * reconciler about every change of a job (src/check-runs/README.md), so GitHub shows what the job is.
 */
export function getRunnerQueue(): RunnerQueue {
  return notifyingRunnerQueue(createRunnerQueueOfTheServer(), checkNotifier);
}

/** #790: the write tokens of the turns of the Implementer among the jobs whose claim ended. */
const revokeTokensOfEndedClaims = endedClaimsReaction({
  allowed: () => getCapabilities().has("implementer"),
  schedule: runAfterResponse,
  tokens: getWriteTokens,
  logger: console,
});

function createRunnerQueueOfTheServer(): RunnerQueue {
  const checkOfRefusal = notifyingRunnerQueue.onRefused(checkNotifier);
  return createRunnerQueue(getDatabase(), {
    // #195: how long a job no capable runner claims may wait; the operator owns the value.
    limits: { noCapableRunnerMs: configuredNoCapableRunnerMs(process.env) },
    // #277: a job refused for the entitlements of its workspace is failed inside the claim; this is its log line
    // (ids and codes only, never a name or a number of the plan).
    onRefused: (refusal) => {
      const { jobId, workspaceId, errorCode, detail } = refusal;
      console.info(
        `[queue] job=${jobId} workspace=${workspaceId} refused at claim: ${errorCode}${detail === undefined ? "" : ` (${detail})`}`,
      );
      // #632: the check run of the refused job is completed with the reason after the response, not left "Waiting".
      checkOfRefusal(refusal);
      // #281: the pull request gets one notice per period, posted after the response of the claim.
      noticeOfRefusal(refusal);
      // #506: a refusal for the balance decided in its transaction that the workspace is empty; the mail goes out now.
      if (
        refusal.errorCode === "insufficient_balance" ||
        refusal.errorCode === "balance_negative"
      )
        deliverBalanceMails();
    },
    // #361: a run settled without a known cost, which no cost limit bounds. One line per run so it can be watched:
    // the ids only, never a figure, a model or a name.
    onUnknownCostSettled: (settlement) => {
      console.warn(unknownCostAlertLine(settlement));
    },
    // #487: the claim of a job ended (a result, a failure, a cancel, a lapsed lease, a timeout): the Dispatcher that
    // started it is told to stop its VM, after the response and best effort. Nothing happens while the instance polls.
    // #493: and, where billing is on, the wall clock of a job that ran on a runner is recorded (no VM to measure).
    onClaimsEnded: (jobIds) => {
      stopEndedClaims(jobIds);
      // #790: the write tokens of an ended turn of the Implementer, however it ended (a result, the reaper, a stop, the timeout).
      revokeTokensOfEndedClaims(jobIds);
      recordWallClocks(jobIds);
      // #506: the settlement of these jobs may have taken a balance below the threshold; the mail goes out after the response.
      deliverBalanceMails();
    },
    // #277: a managed cost limit next to the own key is read by nothing; say so once, with the id of the workspace only.
    onIgnoredCostLimit: (workspaceId) => {
      if (ignoredCostLimitLogged.has(workspaceId)) return;
      ignoredCostLimitLogged.add(workspaceId);
      console.info(
        `[queue] workspace=${workspaceId} has a managed cost limit next to the own key; the limit is ignored (cost_limit_requires_managed_key)`,
      );
    },
  });
}
