// SPDX-License-Identifier: LicenseRef-Proprietary

// The reaper (#364): stops the Sandbox VMs of ours that outlived their purpose. The App's signed stop
// (`POST /stop`, #487) ends a job's VM when the job ends, and the Launcher stops the VM of a launch that failed before the
// hand-over; when neither happens (a stop that never arrived or failed, a restart, an App of a previous release) the VM
// is billed until its own timeout. This is the second line, run by the cron route (route.ts). It decides per VM, in this order:
//
//   - not one of ours (vm-shape.ts), or not running: not touched
//   - younger than two minutes: not touched (a launch in progress, a listing that lags)
//   - older than its maximum lifetime: stopped, whatever the App says (its own timeout, or the configured one, plus a
//     grace period: by then the platform's own timeout has failed to end it)
//   - a canary (no job): kept, only its lifetime ends it
//   - a job VM: stopped when the App says its job is not `running`; kept when it is, kept while the job is draining (a
//     superseded run whose Worker is finishing its requests and reporting, #397), and kept when the App's answer
//     cannot be read (fail safe: only the lifetime stops it then). With several apps (#730) the question goes to the app
//     the VM's `tenant` tag names (no tag: `reviewer`), and to no other; a tag that names an app this Dispatcher does not
//     serve is an answer that cannot be read
//
// Stopping is by the listed name; a failed stop is counted and retried by the next run. Nothing here logs a credential
// or the platform's own error text.
//
// Retention (#802): the platform keeps a stopped VM until somebody deletes it, and the listing every claim and every run
// makes grows with them (283 stopped VMs took 5.1 s). So, after the stops, the reaper deletes the VMs of ours (the same
// rule, `shapeOf`) that the platform reports `stopped` and that were created three days ago or earlier: a job VM lives for
// seven hours at most, so by then it has been over for days. At most `MAX_DELETES_PER_RUN` per run, the oldest first, so a
// run stays well inside its time limit and a backlog drains over several runs; a failed delete is counted, costs a place in
// the bound and is retried by the next run. Nothing running, pending or stopping is deleted, and neither is anything that
// is not exactly ours (a persistent VM, the golden builder, a lookalike): the check is the one that decides what to stop.
import type { JobStateResult } from "../core/app-client.ts";
import type { Logger } from "../core/types.ts";
import type { ListedVm, SandboxFleet } from "../launchers/sandbox-service.ts";
import {
  APP_TAG,
  NAME_PREFIX,
  isLive,
  shapeOf,
  type VmShape,
} from "./vm-shape.ts";

/** A VM younger than this is never touched. */
export const MIN_AGE_MS = 120_000;
/** How long after its lifetime (the VM's own timeout) a VM may still exist before the reaper stops it. */
export const LIFETIME_GRACE_MS = 120_000;
/** The longest a job VM may have lived by its own timeout: the longest job (6 h) plus the largest margin (1 h). */
export const MAX_JOB_VM_LIFETIME_MS = (21_600 + 3600) * 1000;
/** The same for a canary: the longest probe (10 min) plus the largest margin. */
export const MAX_CANARY_LIFETIME_MS = (600 + 3600) * 1000;
/** A stopped VM is deleted once it was created this long ago (#802). */
export const RETENTION_MS = 3 * 24 * 3600 * 1000;
/**
 * The most VMs one run deletes (#802). Each takes a lookup and a delete call; with four at a time that is seconds, far inside
 * the function's limit, and the cron runs every five minutes: 50 per run drains 283 VMs in six runs, half an hour.
 */
export const MAX_DELETES_PER_RUN = 50;
const CONCURRENCY = 4;

export const REAP_ERROR_CODES = ["REAP_LIST_FAILED"] as const;
export type ReapErrorCode = (typeof REAP_ERROR_CODES)[number];

export class ReapError extends Error {
  readonly code: ReapErrorCode;

  constructor(code: ReapErrorCode) {
    super(code);
    this.name = "ReapError";
    this.code = code;
  }
}

/** Counts only: the answer of the cron route. */
export type ReapReport = {
  /** VMs the platform returned. */
  listed: number;
  /** Of those, the live VMs of ours. */
  candidates: number;
  stopped: number;
  /** Candidates left running: young, inside their lifetime, job still running or state unreadable. */
  kept: number;
  /** Candidates whose job state could not be read. */
  unreadable: number;
  /** Stops that failed; the next run retries them. */
  failed: number;
  /** Stopped VMs deleted by the retention (#802). */
  deleted: number;
  /** Deletes that failed; the next run retries them. */
  deleteFailed: number;
};

export type ReaperOptions = {
  fleet: SandboxFleet;
  /**
   * The state of a job in the app `appId`. It answers `unreadable` for an app it does not know, so a VM of an unknown
   * tenant is left to its lifetime.
   */
  jobs: { jobState(jobId: string, appId: string): Promise<JobStateResult> };
  logger: Logger;
  now?: () => number;
  /** A job VM's lifetime when the platform reports none: the job timeout plus the VM margin. */
  jobLifetimeSeconds: number;
  /** A canary's: the probe timeout plus the VM margin. */
  canaryLifetimeSeconds: number;
};

export type Reaper = { run(signal?: AbortSignal): Promise<ReapReport> };

type Candidate = { vm: ListedVm; shape: VmShape };
type Verdict = "stop_lifetime" | "stop_job_ended" | "keep";

function askKey(shape: { jobId: string; appId: string }): string {
  return `${shape.appId}:${shape.jobId}`;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function createReaper(options: ReaperOptions): Reaper {
  const { fleet, jobs, logger } = options;
  const now = options.now ?? (() => Date.now());

  /**
   * The VM's own timeout when the platform reports a believable one, the configured lifetime otherwise, plus the grace.
   * The ages compare this function's clock with the platform's `createdAt`, so a skew between them moves every age.
   * The only margin against it is the grace and the minimum age (two minutes each): a function clock more than that
   * ahead could stop a job VM inside its own timeout, but only in its last seconds, and the same skew the other way only
   * delays a stop. Accepted: a VM is never stopped early by more than the margin, and its own timeout is the backstop.
   */
  function lifetimeMs({ vm, shape }: Candidate): number {
    const [fallbackMs, boundMs] =
      shape.kind === "job"
        ? [options.jobLifetimeSeconds * 1000, MAX_JOB_VM_LIFETIME_MS]
        : [options.canaryLifetimeSeconds * 1000, MAX_CANARY_LIFETIME_MS];
    const reported = vm.timeoutMs;
    const own =
      reported !== undefined &&
      Number.isFinite(reported) &&
      reported > 0 &&
      reported <= boundMs
        ? reported
        : fallbackMs;
    return own + LIFETIME_GRACE_MS;
  }

  async function stateOf(
    jobId: string,
    appId: string,
  ): Promise<JobStateResult> {
    try {
      return await jobs.jobState(jobId, appId);
    } catch {
      return { kind: "unreadable" };
    }
  }

  return {
    async run(signal) {
      let listed: readonly ListedVm[];
      try {
        listed = await fleet.list(
          { namePrefix: NAME_PREFIX, tags: { app: APP_TAG } },
          signal,
        );
      } catch {
        // The platform's own text is not ours to log.
        logger.error("reap_list_failed");
        throw new ReapError("REAP_LIST_FAILED");
      }

      const at = now();
      const candidates: Candidate[] = [];
      for (const vm of listed) {
        const shape = shapeOf(vm);
        if (shape !== null && isLive(vm)) candidates.push({ vm, shape });
      }

      // First what needs no question to the App, then one question per job that does.
      const verdicts = new Map<Candidate, Verdict>();
      const toAsk: Candidate[] = [];
      for (const candidate of candidates) {
        const age = at - candidate.vm.createdAtMs;
        if (age < MIN_AGE_MS) verdicts.set(candidate, "keep");
        else if (age >= lifetimeMs(candidate))
          verdicts.set(candidate, "stop_lifetime");
        else if (candidate.shape.kind === "canary")
          verdicts.set(candidate, "keep");
        else toAsk.push(candidate);
      }

      // One question per job of one app: the same job id in two apps is two jobs.
      const questions = [
        ...new Map(
          toAsk.flatMap(({ shape }) =>
            shape.kind === "job"
              ? [[askKey(shape), { jobId: shape.jobId, appId: shape.appId }]]
              : [],
          ),
        ),
      ];
      const states = new Map<string, JobStateResult>();
      await mapLimit(questions, CONCURRENCY, async ([key, question]) => {
        states.set(key, await stateOf(question.jobId, question.appId));
      });
      let unreadable = 0;
      for (const [key, question] of questions)
        if (states.get(key)?.kind !== "known") {
          logger.warn("job_state_unreadable", {
            app: question.appId,
            jobId: question.jobId,
          });
        }
      for (const candidate of toAsk) {
        const state =
          candidate.shape.kind === "job"
            ? states.get(askKey(candidate.shape))
            : undefined;
        // A superseded job that drains (#397) is not over: its Worker is finishing the requests in flight and
        // reporting what they cost, so its VM stays until the claim ends.
        if (
          state?.kind === "known" &&
          state.status !== "running" &&
          state.draining !== true
        )
          verdicts.set(candidate, "stop_job_ended");
        else {
          verdicts.set(candidate, "keep");
          if (state?.kind !== "known") unreadable += 1;
        }
      }

      const toStop = candidates.filter(
        (candidate) => verdicts.get(candidate) !== "keep",
      );
      const outcomes = await mapLimit(
        toStop,
        CONCURRENCY,
        async (candidate) => {
          const reason = verdicts.get(candidate);
          try {
            await fleet.stop(candidate.vm.name);
          } catch {
            logger.warn("vm_reap_failed", {
              sandbox: candidate.vm.name,
              reason,
            });
            return false;
          }
          logger.info("vm_reaped", { sandbox: candidate.vm.name, reason });
          return true;
        },
      );

      const stopped = outcomes.filter(Boolean).length;

      // The retention: the oldest stopped VMs of ours, up to the bound.
      const expired = listed
        .filter(
          (vm) =>
            vm.status === "stopped" &&
            at - vm.createdAtMs >= RETENTION_MS &&
            shapeOf(vm) !== null,
        )
        .sort((a, b) => a.createdAtMs - b.createdAtMs)
        .slice(0, MAX_DELETES_PER_RUN);
      const deletions = await mapLimit(expired, CONCURRENCY, async (vm) => {
        try {
          await fleet.delete(vm.name);
        } catch {
          // The platform's own text is not ours to log.
          logger.warn("vm_delete_failed", { sandbox: vm.name });
          return false;
        }
        logger.info("vm_deleted", { sandbox: vm.name });
        return true;
      });
      const deleted = deletions.filter(Boolean).length;

      const report: ReapReport = {
        listed: listed.length,
        candidates: candidates.length,
        stopped,
        kept: candidates.length - toStop.length,
        unreadable,
        failed: outcomes.length - stopped,
        deleted,
        deleteFailed: deletions.length - deleted,
      };
      logger.info("reap_done", report);
      return report;
    },
  };
}
