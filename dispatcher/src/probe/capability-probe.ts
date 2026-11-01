// SPDX-License-Identifier: LicenseRef-Proprietary

// The canary probe of a Dispatcher instance (#331, #479): it runs the Worker image's `probe` mode somewhere that has
// the real hardening (a canary VM, see launchers/sandbox-canary.ts) and reports what it found. It serves `POST /probe`,
// the deploy canary, and nothing else: **dispatch and claim never run it and never wait for it** (#479). The proof that
// a deployment may run Dynamic jobs is the canary that passed before the deployment went live; the snapshot pair and
// the settings cannot change during its lifetime. Fail closed, in every direction:
//
//   - the container says no, or says something that is not a verdict, or the probe cannot run, or it takes too
//     long: the report says so with a stable reason or code, never the text of anything
//   - one probe at a time per instance: any number of callers share the one that is running
//   - a forced probe is served from the last answer when it is younger than `forceReuseMs`, so a holder of the
//     credential cannot run canary VMs back to back
//
// Platform-free: the run itself is a function the caller brings.
import type { Clock, Engine, Logger } from "../core/types.ts";
import { probeFailureCode, type ProbeFailureCode } from "./failure-codes.ts";
import { parseProbeOutput, type ProbeReason } from "./verdict.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 150 * 1000;
/** A forced probe (`POST /probe`) is served from an answer younger than this instead of starting another VM. */
export const DEFAULT_PROBE_FORCE_REUSE_MS = 60 * 1000;
/** After a timeout, how long to wait for the run to finish stopping what it started (the canary's VM). */
export const DEFAULT_PROBE_ABORT_GRACE_MS = 10 * 1000;

/** A probe that could not be run. The code is stable; the message is not read by anyone. */
export class ProbeRunError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ProbeRunError";
    this.code = code;
  }
}

/**
 * Runs the probe once and returns the stdout of the container's `probe` mode. Rejects (ideally with a
 * `ProbeRunError` or a `LaunchError`, anything with a stable `code`) when it could not run. It must stop and clean
 * up what it started when `signal` aborts (the timeout).
 */
export type ProbeRunner = (signal: AbortSignal) => Promise<string>;

export type ProbeStatus = "passed" | "denied" | "failed";

/** What the probe found. Holds engines, stable reasons and a stable code and nothing else. */
export type ProbeOutcome = {
  status: ProbeStatus;
  /** What the container may advertise: `opencode` only for `passed`, `implementer` only on top of it. */
  engines: Engine[];
  /** Why the container left `opencode` out (`denied`). */
  reasons: ProbeReason[];
  /** Why no verdict was read (`failed`): a code of the closed list (`failure-codes.ts`). */
  failure?: ProbeFailureCode;
  /** Milliseconds on the probe's clock when the answer was read. */
  checkedAt: number;
};

export type CapabilityProbeOptions = {
  run: ProbeRunner;
  clock: Clock;
  /** Milliseconds, on the same time line as the clock; a test moves both by hand. */
  now: () => number;
  logger: Logger;
  timeoutMs?: number;
  /** A forced probe is served from an answer younger than this (0: never). */
  forceReuseMs?: number;
  /** How long a timed out run may take to finish stopping what it started before the probe answers anyway. */
  abortGraceMs?: number;
};

export interface CapabilityProbe {
  /** Runs a probe now, or joins the one that runs, whatever the age of the last answer. Never rejects. */
  refresh(): Promise<ProbeOutcome>;
  /**
   * A forced probe (`POST /probe`): joins the one that runs, else serves the last answer (any status) when it is
   * younger than the reuse time, else runs one.
   */
  force(): Promise<ProbeOutcome>;
}

export function createCapabilityProbe(
  options: CapabilityProbeOptions,
): CapabilityProbe {
  const { run, clock, now, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const forceReuseMs = options.forceReuseMs ?? DEFAULT_PROBE_FORCE_REUSE_MS;
  const abortGraceMs = options.abortGraceMs ?? DEFAULT_PROBE_ABORT_GRACE_MS;
  /** The latest answer of any status: what a forced probe may reuse. */
  let last: ProbeOutcome | undefined;
  let running: Promise<ProbeOutcome> | undefined;

  function failed(value: unknown): ProbeOutcome {
    const code = probeFailureCode(value);
    const at = now();
    logger.warn("probe_failed", { code });
    return {
      status: "failed",
      engines: ["pr-agent"],
      reasons: [],
      failure: code,
      checkedAt: at,
    };
  }

  async function execute(): Promise<ProbeOutcome> {
    const stop = new AbortController();
    const finished = new AbortController();
    const timer = clock
      .sleep(timeoutMs, finished.signal)
      .then(() => (finished.signal.aborted ? undefined : ("timeout" as const)));
    let attempt: Promise<string> | undefined;
    try {
      attempt = run(stop.signal);
      // A run that ends after its timeout must not be an unhandled rejection.
      attempt.catch(() => undefined);
      const result = await Promise.race([
        attempt.then((stdout) => ({ stdout })),
        timer,
      ]);
      if (result === "timeout" || result === undefined) {
        stop.abort();
        // The VM is stopped by the run's own cleanup, which must be finished before the work that holds the
        // function alive ends (`waitUntil`): wait for it, but not for ever.
        const grace = new AbortController();
        await Promise.race([
          attempt.then(
            () => undefined,
            () => undefined,
          ),
          clock.sleep(abortGraceMs, grace.signal),
        ]);
        grace.abort();
        return failed("probe_timeout");
      }
      const verdict = parseProbeOutput(result.stdout);
      if (verdict === undefined) return failed("probe_unreadable");
      const at = now();
      if (verdict.passed) {
        logger.info("probe_passed", { engines: verdict.engines });
        return {
          status: "passed",
          engines: verdict.engines,
          // Only the Implementer's reasons can be here: why `implementer` is missing from a deployment that serves it.
          reasons: verdict.reasons,
          checkedAt: at,
        };
      }
      logger.warn("probe_denied", { reasons: verdict.reasons });
      return {
        status: "denied",
        engines: verdict.engines.filter(
          (engine) => engine !== "opencode" && engine !== "implementer",
        ),
        reasons: verdict.reasons,
        checkedAt: at,
      };
    } catch (error) {
      stop.abort();
      return failed(
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined,
      );
    } finally {
      finished.abort();
    }
  }

  function refresh(): Promise<ProbeOutcome> {
    if (running !== undefined) return running;
    const started = execute()
      .then((outcome) => {
        last = outcome;
        return outcome;
      })
      .finally(() => {
        running = undefined;
      });
    running = started;
    return started;
  }

  return {
    refresh,
    force() {
      if (running !== undefined) return running;
      if (
        last !== undefined &&
        forceReuseMs > 0 &&
        now() - last.checkedAt < forceReuseMs
      )
        return Promise.resolve(last);
      return refresh();
    },
  };
}
