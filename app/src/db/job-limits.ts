// SPDX-License-Identifier: LicenseRef-Proprietary

// The time and attempt limits of the queue. Defaults follow the project decisions; the queue takes
// overrides so tests (and, later, the settings) can shorten them.

/** A runner holds a job for this long after its last heartbeat (runners beat every 30 seconds). */
export const DEFAULT_LEASE_MS = 2 * 60 * 1000;

/**
 * A job that runs longer than this is failed with `timeout`, whatever its heartbeats say: the
 * runner's hard timeout (20 minutes by default) plus 5 minutes of grace.
 */
export const DEFAULT_MAX_RUNTIME_MS = 25 * 60 * 1000;

/** How many times a job may be started in all; the last lost lease fails the job. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * #195: how long a Dynamic job may wait for a runner that can run it. Until #202 ships the engine no
 * production runner advertises `opencode`, so a Dynamic job would otherwise wait forever. After this
 * deadline it is cancelled with `no_capable_runner` — never failed for a review reason, and no attempt
 * is counted. The operator owns the value (`RUNNER_NO_CAPABLE_TIMEOUT_SECONDS`).
 */
export const DEFAULT_NO_CAPABLE_RUNNER_MS = 30 * 60 * 1000;

/**
 * #752: the deadline above is waived while a runner of the same engine is busy (a job of the kind runs or ended within it), because a
 * busy pool is not "no capable runner". This is the absolute limit: a queued job older than it is cancelled with
 * `no_capable_runner` whatever the pool does, so no job waits forever behind a pool that never frees up. An operator's deadline longer than this wins: the job then goes at the deadline.
 */
export const DEFAULT_NO_CAPABLE_RUNNER_ABSOLUTE_MS = 3 * 60 * 60 * 1000;

/**
 * #752: a turn of the Implementer is started once and never silently run again: a second run would meet the branch the first one
 * already pushed to. A lost lease or a released claim fails the turn on its first attempt. Not a setting: nothing may raise it.
 */
export const IMPLEMENTER_MAX_ATTEMPTS = 1;

/**
 * #752: the hard timeout of a turn: the Dispatcher's job timeout for the kind (60 minutes, `IMPLEMENTER_JOB_TIMEOUT_SECONDS` in
 * `billing/hold.ts`) plus 10 of grace. Another kind keeps `DEFAULT_MAX_RUNTIME_MS`.
 */
export const DEFAULT_IMPLEMENTER_MAX_RUNTIME_MS = 70 * 60 * 1000;

export type JobQueueLimits = {
  leaseMs: number;
  /** The hard timeout of a Diff or Dynamic job. */
  maxRuntimeMs: number;
  /** The hard timeout of a turn of the Implementer (#752). */
  implementerMaxRuntimeMs: number;
  maxAttempts: number;
  noCapableRunnerMs: number;
  /** The age at which a queued job is cancelled although a runner of its engine is busy (#752). */
  noCapableRunnerAbsoluteMs: number;
};

export const DEFAULT_JOB_QUEUE_LIMITS: JobQueueLimits = {
  leaseMs: DEFAULT_LEASE_MS,
  maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
  implementerMaxRuntimeMs: DEFAULT_IMPLEMENTER_MAX_RUNTIME_MS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  noCapableRunnerMs: DEFAULT_NO_CAPABLE_RUNNER_MS,
  noCapableRunnerAbsoluteMs: DEFAULT_NO_CAPABLE_RUNNER_ABSOLUTE_MS,
};

/** The environment variable an operator sets to own the deadline; seconds. */
export const NO_CAPABLE_RUNNER_VARIABLE = "RUNNER_NO_CAPABLE_TIMEOUT_SECONDS";

/**
 * The operator's deadline for a job no capable runner claims (#195). A missing, non-numeric or
 * non-positive value keeps the default, so a typo never disables the bound.
 */
export function configuredNoCapableRunnerMs(
  environment: Record<string, string | undefined>,
): number {
  const raw = environment[NO_CAPABLE_RUNNER_VARIABLE]?.trim();
  if (!raw) return DEFAULT_NO_CAPABLE_RUNNER_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0)
    return DEFAULT_NO_CAPABLE_RUNNER_MS;
  return Math.round(seconds * 1000);
}
