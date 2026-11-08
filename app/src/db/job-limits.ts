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

/**
 * #918: a turn that carries its own time limit (`implementer_turns.time_limit_minutes`, the `turnTimeLimitMinutes` of a workflow) is
 * cut by the app that long after the limit, the grace the 70 minutes above are made of (60 plus 10): the runner holds the turn to its
 * limit itself and keeps the last minutes of it for the final commit and push.
 */
export const IMPLEMENTER_RUNTIME_GRACE_MS = 10 * 60 * 1000;

/**
 * #854: how long a turn of a runner environment waits for a runner of its workspace with its labels. After this it is cancelled with
 * `no_runner_available`, free. The operator owns the value (`RUNNER_WAIT_DEADLINE_MINUTES`).
 */
export const DEFAULT_NO_RUNNER_AVAILABLE_MS = 30 * 60 * 1000;

/**
 * #891: how long the holder of a running job gets to stop a turn a member asked it to stop. The Worker learns of it at its next heartbeat
 * (30 seconds at most), the process ends the agent, pushes what is committed and takes the snapshot within the 115 seconds of its stop, and the
 * report follows. After this the app ends the job `cancelled` itself (a holder that heard nothing, or died, stops being asked and cannot
 * push any more).
 */
export const DEFAULT_CANCEL_GRACE_MS = 4 * 60 * 1000;

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
  /** How long a turn of a runner environment waits for a runner of its workspace (#854). */
  noRunnerAvailableMs: number;
  /** How long the holder of a job a member asked to stop has to stop it before the app ends the job (#891). */
  cancelGraceMs: number;
};

export const DEFAULT_JOB_QUEUE_LIMITS: JobQueueLimits = {
  leaseMs: DEFAULT_LEASE_MS,
  maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
  implementerMaxRuntimeMs: DEFAULT_IMPLEMENTER_MAX_RUNTIME_MS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  noCapableRunnerMs: DEFAULT_NO_CAPABLE_RUNNER_MS,
  noCapableRunnerAbsoluteMs: DEFAULT_NO_CAPABLE_RUNNER_ABSOLUTE_MS,
  noRunnerAvailableMs: DEFAULT_NO_RUNNER_AVAILABLE_MS,
  cancelGraceMs: DEFAULT_CANCEL_GRACE_MS,
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

/** The environment variable an operator sets to own the wait for a runner of a workspace; minutes. */
export const RUNNER_WAIT_DEADLINE_VARIABLE = "RUNNER_WAIT_DEADLINE_MINUTES";

/**
 * The operator's wait for a runner (#854). A missing, non-numeric or non-positive value keeps the default, so a typo never makes a turn
 * wait for ever or fail at once.
 */
export function configuredNoRunnerAvailableMs(
  environment: Record<string, string | undefined>,
): number {
  const raw = environment[RUNNER_WAIT_DEADLINE_VARIABLE]?.trim();
  if (!raw) return DEFAULT_NO_RUNNER_AVAILABLE_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0)
    return DEFAULT_NO_RUNNER_AVAILABLE_MS;
  return Math.round(minutes * 60 * 1000);
}
