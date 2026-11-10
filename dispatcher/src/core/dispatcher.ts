// SPDX-License-Identifier: LicenseRef-Proprietary

// The Dispatcher core: the platform-free part between a Trigger (which learns that a job exists) and a
// Launcher (which starts its Worker). It claims, holds the per-job credential only while it hands the job
// over, keeps the lease alive during the launch and gives the job back when the launch fails.
//
//   handle(hint) -> capability check -> app's kinds -> capacity -> fleet cap (several apps) -> App version -> claim -> kind and engine check -> { started, background }
//   background:  launch(spec) while heartbeating with the job credential
//                deadline, lost lease or abort -> stop the launch; launch failed -> release(launch_failed)
//   after that:  nothing. The Worker owns the lease and the core never looks at the job again (#487); the App tells the
//                Dispatcher when the claim ends (`POST /stop`)
//
// It never sees the job input, the git token or the model key: the App hands those to the Worker.
//
// Several apps (#730): every call names the app (`hint.appId`, the app whose signing key verified the wake-up call). The
// core keeps one client, one slot counter and one version memory per app, claims at that app only (a 204 is `ignored`:
// there is no looking at another app), refuses a kind the app is not allowed before and after the claim, and hands the
// Launcher the registry's URL of the app that claimed, never anything a request said. Where the platform can be listed and
// there is more than one app (`liveVms`), the cap of an app is also the Dispatcher's own count of that app's live VMs plus
// its launches in flight, so an app that ignores its cap (a bug, a compromise) cannot take the concurrency of another.
// That count is a soft limit and never a reason to stop a whole product's reviews (#802): when the platform cannot be
// listed and no listing is young enough, the Dispatcher counts what it knows itself (the launches in progress and the VMs
// its launches created lately) and the claim goes on. The platform's own concurrency limit stays the hard one.
import {
  createAppClient,
  type AppClient,
  type AppFailure,
  type ClaimedJob,
  type ReleaseReason,
  VM_LIFECYCLE_FEATURE,
} from "./app-client.ts";
import { systemClock } from "./clock.ts";
import { vcpusOfSizeLabel } from "./size-labels.ts";
import {
  ENGINE_BY_KIND,
  jobTimeoutFor,
  launchConfigFor,
  type AppSettings,
  type Clock,
  type CoreSettings,
  type CreatedVm,
  type DispatcherCore,
  type Engine,
  type HandleResult,
  type JobHint,
  type Launcher,
  LaunchError,
  type LiveVmCounter,
  type Logger,
} from "./types.ts";

const DEFAULT_RETRY_BUSY_SECONDS = 30;
const DEFAULT_RETRY_UNAVAILABLE_SECONDS = 60;
const DEFAULT_RETRY_REJECTED_SECONDS = 300;
const RETRY_CEILING_SECONDS = 3600;
/** How long the App is asked not to offer a released job again (a platform outage should not burn all attempts at once). */
const RELEASE_RETRY_AFTER_SECONDS = 30;
const RELEASE_ATTEMPTS = 3;
/** The App's answer to the version question is remembered this long. */
const VERSION_TTL_MS = 10 * 60 * 1000;
const MIN_HEARTBEAT_SECONDS = 5;
/** The listing of the live VMs is reused this long: a claim must not cost a platform call each. */
const LIVE_VMS_TTL_MS = 5 * 1000;
/** A listing that has not answered by then is a failed one: a hang must not hold up the claims that wait for it. */
const LIVE_VMS_TIMEOUT_MS = 4 * 1000;
/**
 * A listing that failed is replaced by the last good one only while it is this young; after that the Dispatcher counts by
 * its own launches (#802). A listing that failed is not asked for again for `LIVE_VMS_TTL_MS`, so a platform that is down
 * does not make every claim wait for it.
 */
const LIVE_VMS_STALE_MS = 60 * 1000;
/**
 * Without a listing, a VM this Dispatcher's launches created counts for this long (#802). It is the guess of how long a job VM
 * is up: much longer would count VMs that ended long ago and, through a long outage, turn the soft cap into a stop; shorter
 * only lets an app a little further above its cap, which the platform's own concurrency limit still bounds.
 */
const OWN_VM_MEMORY_MS = 10 * 60 * 1000;

/** #971: the size a job's VM starts with: what its environment names, else what its size label names; undefined for the kind's own. */
function launchedVcpus(job: ClaimedJob): number | undefined {
  if (job.vcpus !== undefined) return job.vcpus;
  return job.sizeLabel === undefined
    ? undefined
    : vcpusOfSizeLabel(job.sizeLabel);
}

/**
 * How far above its cap an app may be by the Dispatcher's count before a call is refused: twice the cap plus two VMs in all.
 * The App enforces the exact cap at the claim; this is a backstop against an app that ignores it (a runaway, not a fair
 * share). It counts VMs, not jobs, and a VM outlives its job for a while: the listing is up to `LIVE_VMS_TTL_MS` old, the
 * stop call of a finished job comes a moment after its result, and the VM of a Worker that died stays until the reaper
 * stops it (every attempt of a crash loop leaves one). An exact comparison would refuse the job the App rightly sends and
 * nothing would wake it again before the sweep (the hosted E2E of a crash loop at cap 1 showed it).
 */
function capTolerance(maxRunning: number): number {
  return maxRunning + 2;
}

/** #493: the pauses before the repeats of a report of the VM that the App could not take (three tries). */
const VM_REPORT_RETRY_MS: readonly number[] = [1000, 3000];

export type CoreDependencies = {
  settings: CoreSettings;
  launcher: Launcher;
  logger: Logger;
  clock?: Clock;
  fetch?: typeof fetch;
  /**
   * The platform's live job VMs per app (#730). Absent where there is no fleet to list (a local Launcher): the cap is then
   * the launches in progress only. Present, an app is refused above its cap (`busy`) whatever it sends.
   */
  liveVms?: LiveVmCounter;
  /** Milliseconds, for the memory of the version answer. */
  now?: () => number;
  requestTimeoutMs?: number;
};

type EnginesAnswer =
  | { kind: "usable"; engines: Engine[] }
  | { kind: "not_capable" }
  | { kind: "retry"; retryAfterSeconds: number };

type Abort = { signal: AbortSignal; why: () => string | undefined };

function clampRetry(seconds: number | undefined, fallback: number): number {
  if (seconds === undefined || seconds < 1) return fallback;
  return Math.min(seconds, RETRY_CEILING_SECONDS);
}

/** Everything the core keeps for one app (#730): nothing of it is shared with another app. */
type AppState = {
  settings: AppSettings;
  client: AppClient;
  /** Launches in progress (claimed or being claimed): the local share of this app's cap. */
  launching: number;
  versionOkUntil: number;
  /** #493: whether the App, as of the last version answer, takes the report of a VM. */
  takesVmReports: boolean;
  /** VMs this app's launches created, ever; with `vmsInFlight` they tell the count of the VMs a listing is too old to show. */
  vmsCreated: number;
  /** Of the launches in progress, those whose VM exists already (they are in `launching` too). */
  vmsInFlight: number;
  /** When this app's launches created their VMs, the last `OWN_VM_MEMORY_MS` of them: the count without a listing (#802). */
  recentVms: number[];
};

type LiveSnapshot = {
  at: number;
  counts: ReadonlyMap<string, number>;
  /** `vmsCreated` of every app when the listing was asked for: what was created after it is not in `counts`. */
  created: ReadonlyMap<string, number>;
};

export function createDispatcherCore(deps: CoreDependencies): DispatcherCore {
  const { settings, launcher, logger } = deps;
  const clock = deps.clock ?? systemClock;
  const now = deps.now ?? (() => Date.now());
  const apps = new Map<string, AppState>();
  for (const configured of settings.apps)
    apps.set(configured.id, {
      settings: configured,
      client: createAppClient({
        appUrl: configured.url,
        token: configured.token,
        poolId: configured.poolId,
        fetch: deps.fetch ?? fetch,
        requestTimeoutMs: deps.requestTimeoutMs,
      }),
      launching: 0,
      versionOkUntil: 0,
      takesVmReports: false,
      vmsCreated: 0,
      vmsInFlight: 0,
      recentVms: [],
    });
  const shutdown = new AbortController();

  /** The engines of the kinds an app may be given: what its claim asks for. */
  function allowedEngines(state: AppState): Engine[] {
    return [
      ...new Set(state.settings.kinds.map((kind) => ENGINE_BY_KIND[kind])),
    ];
  }

  async function engines(hint: JobHint): Promise<EnginesAnswer> {
    let offered: readonly Engine[];
    try {
      offered = await launcher.capabilities(shutdown.signal);
    } catch {
      logger.error("capabilities_failed");
      return {
        kind: "retry",
        retryAfterSeconds: DEFAULT_RETRY_UNAVAILABLE_SECONDS,
      };
    }
    const usable = settings.engines.filter((engine) =>
      offered.includes(engine),
    );
    if (usable.length === 0) return { kind: "not_capable" };
    if (
      hint.reviewKind !== undefined &&
      !usable.includes(ENGINE_BY_KIND[hint.reviewKind])
    )
      return { kind: "not_capable" };
    return { kind: "usable", engines: usable };
  }

  let live: LiveSnapshot | undefined;
  /** When the last listing failed; none is asked for until `LIVE_VMS_TTL_MS` later. */
  let failedAt: number | undefined;
  let listing: Promise<LiveSnapshot | undefined> | undefined;

  /**
   * One listing at a time, reused for a few seconds. A failed one (a rejection or no answer in `LIVE_VMS_TIMEOUT_MS`, even
   * from a platform that ignores the signal) is replaced by the last good one while that is young, and by nothing after
   * that: the caller counts by the Dispatcher's own launches then.
   */
  async function refreshLive(
    counter: LiveVmCounter,
  ): Promise<LiveSnapshot | undefined> {
    const created = new Map(
      [...apps].map(([id, state]) => [id, state.vmsCreated]),
    );
    const at = now();
    const timedOut = new AbortController();
    const answered = new AbortController();
    void clock.sleep(LIVE_VMS_TIMEOUT_MS, answered.signal).then(() => {
      if (!answered.signal.aborted) timedOut.abort();
    });
    const signal = AbortSignal.any([shutdown.signal, timedOut.signal]);
    const gaveUp = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(new Error("fleet_list_timeout"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
    gaveUp.catch(() => undefined);
    try {
      live = {
        at,
        counts: await Promise.race([counter(signal), gaveUp]),
        created,
      };
      failedAt = undefined;
    } catch {
      // The platform's own text is not ours to log.
      failedAt = now();
      logger.error("fleet_list_failed", { ms: failedAt - at });
    } finally {
      answered.abort();
    }
    return youngLive();
  }

  function youngLive(): LiveSnapshot | undefined {
    return live !== undefined && now() - live.at < LIVE_VMS_STALE_MS
      ? live
      : undefined;
  }

  async function liveSnapshot(
    counter: LiveVmCounter,
  ): Promise<LiveSnapshot | undefined> {
    if (live !== undefined && now() - live.at < LIVE_VMS_TTL_MS) return live;
    if (failedAt !== undefined && now() - failedAt < LIVE_VMS_TTL_MS)
      return youngLive();
    listing ??= refreshLive(counter).finally(() => {
      listing = undefined;
    });
    return listing;
  }

  /**
   * What the app occupies, by the Dispatcher's own count: the live VMs of the last listing, the VMs created since, and the
   * launches in progress that have no VM yet (the others are in the listing or in the VMs created since). The launch asked
   * about is not among them yet: the caller adds it.
   */
  function occupied(state: AppState, snapshot: LiveSnapshot): number {
    const id = state.settings.id;
    return (
      (snapshot.counts.get(id) ?? 0) +
      (state.vmsCreated - (snapshot.created.get(id) ?? 0)) +
      (state.launching - state.vmsInFlight)
    );
  }

  /**
   * What the app occupies when there is no listing young enough (#802): what the Dispatcher knows itself, the launches in
   * progress that have no VM yet and the VMs its launches created lately. It errs low (a VM created before the memory ended
   * is not counted), which the platform's concurrency limit makes safe. The launch asked about is not among them.
   */
  function knownOccupied(state: AppState): number {
    const since = now() - OWN_VM_MEMORY_MS;
    state.recentVms = state.recentVms.filter((createdAt) => createdAt > since);
    return state.recentVms.length + (state.launching - state.vmsInFlight);
  }

  async function appSupportsTheSplit(
    state: AppState,
  ): Promise<
    { ok: true } | { ok: false; code: AppFailure; retryAfterSeconds?: number }
  > {
    if (now() < state.versionOkUntil) return { ok: true };
    const checked = await state.client.checkVersion();
    if (!checked.ok) return checked;
    state.versionOkUntil = now() + VERSION_TTL_MS;
    state.takesVmReports = checked.features.includes(VM_LIFECYCLE_FEATURE);
    return { ok: true };
  }

  function busy(state: AppState): HandleResult {
    logger.info("busy", {
      app: state.settings.id,
      launching: state.launching,
    });
    return { outcome: "busy", retryAfterSeconds: DEFAULT_RETRY_BUSY_SECONDS };
  }

  async function handle(hint: JobHint): Promise<HandleResult> {
    const state = apps.get(hint.appId);
    if (state === undefined) {
      // Cannot happen for a call a verified key led to; fail closed all the same.
      logger.error("app_unknown");
      return { outcome: "not_capable" };
    }
    const app = state.client;
    const appId = state.settings.id;
    const answer = await engines(hint);
    if (answer.kind === "retry")
      return {
        outcome: "unavailable",
        retryAfterSeconds: answer.retryAfterSeconds,
      };
    if (answer.kind === "not_capable") {
      logger.info("not_capable", { app: appId, reviewKind: hint.reviewKind });
      return { outcome: "not_capable" };
    }
    // The first wall of the job kinds (#730): a kind the app may not submit is never claimed.
    if (
      hint.reviewKind !== undefined &&
      !state.settings.kinds.includes(hint.reviewKind)
    ) {
      logger.warn("kind_not_allowed", {
        app: appId,
        reviewKind: hint.reviewKind,
        stage: "dispatch",
      });
      return { outcome: "not_capable" };
    }
    // The claim asks for the engines of the app's kinds only, so an app is never handed a job it may not have.
    const allowed = allowedEngines(state);
    const claimEngines = answer.engines.filter((engine) =>
      allowed.includes(engine),
    );
    if (claimEngines.length === 0) {
      logger.info("not_capable", { app: appId, reviewKind: hint.reviewKind });
      return { outcome: "not_capable" };
    }
    if (state.launching >= state.settings.maxRunning) return busy(state);

    // The listing is waited for before a slot is taken: a call that waits holds none, so a platform that answers slowly
    // cannot fill the cap with calls that launch nothing.
    if (deps.liveVms !== undefined) {
      const snapshot = await liveSnapshot(deps.liveVms);
      // Calls that waited for the same listing, and launches that began meanwhile, are counted now.
      if (state.launching >= state.settings.maxRunning) return busy(state);
      // This launch is one more than the Dispatcher's count.
      const used =
        (snapshot === undefined
          ? knownOccupied(state)
          : occupied(state, snapshot)) + 1;
      const tolerance = capTolerance(state.settings.maxRunning);
      if (used > state.settings.maxRunning + tolerance) {
        logger.warn("app_cap_reached", {
          app: appId,
          occupied: used - 1,
          maxRunning: state.settings.maxRunning,
          tolerance,
        });
        return {
          outcome: "busy",
          retryAfterSeconds: DEFAULT_RETRY_BUSY_SECONDS,
        };
      }
    }

    // The slot is taken with no await between the last check and here, so two wake-up calls cannot both pass the check.
    state.launching += 1;
    let handedOver = false;
    try {
      const supported = await appSupportsTheSplit(state);
      if (!supported.ok) {
        logger.error("app_unsupported", { app: appId, code: supported.code });
        return {
          outcome: "unavailable",
          retryAfterSeconds: clampRetry(
            supported.retryAfterSeconds,
            DEFAULT_RETRY_UNAVAILABLE_SECONDS,
          ),
        };
      }
      const claimed = await app.claim({
        engines: claimEngines,
        ...(hint.jobId === undefined ? {} : { jobId: hint.jobId }),
        maxRunning: state.settings.maxRunning,
      });
      if (claimed.kind === "none") {
        logger.info("claim_none", { app: appId, jobId: hint.jobId });
        return { outcome: "ignored" };
      }
      if (claimed.kind === "busy") {
        logger.warn("claim_busy", { app: appId, jobId: hint.jobId });
        return {
          outcome: "busy",
          retryAfterSeconds: clampRetry(
            claimed.retryAfterSeconds,
            DEFAULT_RETRY_BUSY_SECONDS,
          ),
        };
      }
      if (claimed.kind === "unavailable") {
        logger.error("claim_failed", {
          app: appId,
          jobId: hint.jobId,
          code: claimed.code,
        });
        const fallback =
          claimed.code === "app_rejected"
            ? DEFAULT_RETRY_REJECTED_SECONDS
            : DEFAULT_RETRY_UNAVAILABLE_SECONDS;
        return {
          outcome: "unavailable",
          retryAfterSeconds: clampRetry(claimed.retryAfterSeconds, fallback),
        };
      }
      // The second wall (#730): a job of a kind the app may not have, or of a kind whose engine this Dispatcher does not
      // serve (a misconfigured or compromised app answers a claim for Diff engines with a Dynamic job), is given back
      // unlaunched, so no VM is created for it.
      // #759: `implementer` is a kind like the others here; only an app whose kinds name it is ever given one.
      const claimedKind = claimed.job.reviewKind;
      const kindAllowed = state.settings.kinds.includes(claimedKind);
      if (!kindAllowed || !claimEngines.includes(ENGINE_BY_KIND[claimedKind])) {
        logger.error("kind_not_allowed", {
          app: appId,
          jobId: claimed.job.id,
          reviewKind: claimed.job.reviewKind,
          stage: "claim",
          reason: kindAllowed ? "engine" : "kind",
        });
        await release(state, claimed.job, "launch_failed");
        return { outcome: "not_capable" };
      }
      // #971: a job requires a size label and this Dispatcher has the labels of the sizes the platform offers. A label that names another
      // size is not its to run: the job is given back unlaunched, like a kind it does not serve.
      if (
        claimed.job.sizeLabel !== undefined &&
        vcpusOfSizeLabel(claimed.job.sizeLabel) === undefined
      ) {
        logger.error("size_not_offered", {
          app: appId,
          jobId: claimed.job.id,
          stage: "claim",
        });
        await release(state, claimed.job, "launch_failed");
        return { outcome: "not_capable" };
      }
      // The slot is given back when the launch phase ends, by the background work.
      handedOver = true;
      return {
        outcome: "started",
        background: runLaunch(state, claimed.job),
      };
    } finally {
      if (!handedOver) state.launching -= 1;
    }
  }

  /** The launch phase of one claimed job. Never rejects. The credential lives in this scope only. */
  async function runLaunch(state: AppState, job: ClaimedJob): Promise<void> {
    const app = state.client;
    const appId = state.settings.id;
    const startedAt = now();
    // Aborts the Launcher: the deadline, a lost lease or a shutdown. Never aborted after a successful launch,
    // because a Launcher may tie the Worker's life to its signal.
    const stop = new AbortController();
    let reason: "deadline" | "lease_lost" | "shutdown" | undefined;
    const stopFor = (why: NonNullable<typeof reason>) => {
      if (reason !== undefined) return;
      reason = why;
      stop.abort();
    };
    const onShutdown = () => stopFor("shutdown");
    shutdown.signal.addEventListener("abort", onShutdown, { once: true });
    if (shutdown.signal.aborted) onShutdown();
    // Ends the timers of this phase, whatever way it ends.
    const phaseDone = new AbortController();
    const timers = AbortSignal.any([phaseDone.signal, stop.signal]);

    const guard: Abort = { signal: stop.signal, why: () => reason };
    const heartbeatMs =
      Math.max(MIN_HEARTBEAT_SECONDS, job.heartbeatIntervalSeconds) * 1000;
    void (async () => {
      for (;;) {
        await clock.sleep(heartbeatMs, timers);
        if (timers.aborted) return;
        const beat = await app.heartbeat(job.id, job.credential);
        if (beat === "lease_lost") {
          logger.warn("lease_lost", { app: appId, jobId: job.id });
          stopFor("lease_lost");
          return;
        }
        if (beat === "failed")
          logger.warn("heartbeat_failed", { app: appId, jobId: job.id });
      }
    })();
    void clock
      .sleep(settings.launchDeadlineSeconds * 1000, phaseDone.signal)
      .then(() => {
        if (!phaseDone.signal.aborted) stopFor("deadline");
      });

    // #493: the reports of the VM the Launcher created, in the background; awaited at the very end only.
    const reports: Promise<void>[] = [];
    let vmCounted = false;
    let inFlight = false;
    let phaseEnded = false;
    const onVmCreated = (vm: CreatedVm) => {
      if (!vmCounted) {
        vmCounted = true;
        state.vmsCreated += 1;
        // Only where the platform is listed for the cap (several apps): a deployment with one app needs no memory of its VMs.
        // Pruned here as well as where it is read, so it stays short when the listing works and nothing reads it.
        if (deps.liveVms !== undefined) {
          const since = now() - OWN_VM_MEMORY_MS;
          state.recentVms = state.recentVms.filter(
            (createdAt) => createdAt > since,
          );
          state.recentVms.push(now());
        }
        // A VM reported after the launch phase ended is created, but no launch is left to hold it in flight.
        if (!phaseEnded) {
          inFlight = true;
          state.vmsInFlight += 1;
        }
      }
      if (!state.takesVmReports) return;
      reports.push(reportVm(state, job, vm));
    };

    try {
      await launchWith(state, job, guard, onVmCreated);
      // The app comes last: the log lines that existed before several apps keep their leading fields, which the hosted E2E
      // reads (`"event":"launched","jobId":...`).
      logger.info("launched", {
        jobId: job.id,
        kind: job.reviewKind,
        ms: now() - startedAt,
        app: appId,
      });
    } catch (error) {
      const code = errorCode(error);
      logger.error("launch_failed", {
        app: appId,
        jobId: job.id,
        kind: job.reviewKind,
        code,
        ...(error instanceof LaunchError ? { retryable: error.retryable } : {}),
        stopped: reason,
      });
      // A lost lease means the App already gave the job away: there is nothing of ours to release.
      if (reason !== "lease_lost") await release(state, job, "launch_failed");
    } finally {
      phaseDone.abort();
      shutdown.signal.removeEventListener("abort", onShutdown);
      phaseEnded = true;
      state.launching -= 1;
      if (inFlight) state.vmsInFlight -= 1;
      // The platform keeps the function alive for the work of the launch: do not end it before the reports are made.
      await Promise.allSettled(reports);
    }
  }

  /**
   * #493: tells the App that the VM exists. Best effort: a bounded repeat for what may pass (no answer, a busy or failing
   * App), none for a refusal, one log line with a stable code when it did not work, and nothing here ever throws or
   * touches the job.
   */
  async function reportVm(
    state: AppState,
    job: ClaimedJob,
    vm: CreatedVm,
  ): Promise<void> {
    try {
      for (let attempt = 0; ; attempt += 1) {
        // #818: the size is reported for a turn of the Implementer only; an App of the release before refuses a field it does not
        // know, and a review's VM is measured by its minutes alone.
        const result = await state.client.reportVm(job.id, job.credential, {
          name: vm.name,
          startedAt: vm.startedAt,
          timeoutSeconds: vm.timeoutSeconds,
          ...(job.reviewKind === "implementer" && vm.vcpus !== undefined
            ? { vcpus: vm.vcpus }
            : {}),
        });
        if (result === "recorded") return;
        const pause = VM_REPORT_RETRY_MS[attempt];
        if (result === "refused" || pause === undefined) break;
        await clock.sleep(pause);
      }
    } catch {
      // Only that it failed.
    }
    logger.warn("vm_report_failed", { app: state.settings.id, jobId: job.id });
  }

  async function launchWith(
    state: AppState,
    job: ClaimedJob,
    guard: Abort,
    onVmCreated: (vm: CreatedVm) => void,
  ): Promise<void> {
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(new AbortedError(guard.why() ?? "aborted"));
      if (guard.signal.aborted) fail();
      else guard.signal.addEventListener("abort", fail, { once: true });
    });
    // A Launcher that ignores the signal cannot hold the deadline hostage.
    const launched = launcher.launch(
      {
        appId: state.settings.id,
        // The registry's URL of the app that claimed the job: never anything a request said.
        appUrl: state.settings.url,
        jobId: job.id,
        credential: job.credential,
        kind: job.reviewKind,
        timeoutSeconds: jobTimeoutFor(settings, job.reviewKind),
        config: launchConfigFor(settings, job.reviewKind),
        // #818: the size is believed for a turn of the Implementer and for no other kind: a review can never name one. #971: the size
        // of its environment when it names one, else the one its size label names.
        ...(job.reviewKind === "implementer" && launchedVcpus(job) !== undefined
          ? { vcpus: launchedVcpus(job) }
          : {}),
        // #745, step 7: the same for the rule of the agent's network; a review never carries one.
        ...(job.reviewKind === "implementer" && job.network !== undefined
          ? { network: job.network }
          : {}),
        ...(job.reviewKind === "implementer" && job.modelHost !== undefined
          ? { modelHost: job.modelHost }
          : {}),
        onVmCreated,
      },
      guard.signal,
    );
    launched.catch(() => undefined);
    await Promise.race([launched, aborted]);
  }

  async function release(
    state: AppState,
    job: ClaimedJob,
    reason: ReleaseReason,
  ): Promise<void> {
    const appId = state.settings.id;
    for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt += 1) {
      const result = await state.client.release(
        job.id,
        job.credential,
        reason,
        RELEASE_RETRY_AFTER_SECONDS,
      );
      if (result === "released") {
        logger.info("released", { app: appId, jobId: job.id, reason });
        return;
      }
      if (result === "ended") {
        // Not a problem: the Worker delivered its result (and may have exited 1 after a failed one). Nothing to give back.
        logger.info("release_job_ended", {
          app: appId,
          jobId: job.id,
          reason,
        });
        return;
      }
      if (result === "not_holder") {
        logger.warn("release_not_holder", {
          app: appId,
          jobId: job.id,
          reason,
        });
        return;
      }
      if (attempt < RELEASE_ATTEMPTS) await clock.sleep(attempt * 1000);
    }
    // The lease runs out and the App gives the job back by itself; the cost is the wait.
    logger.error("release_failed", { app: appId, jobId: job.id, reason });
  }

  return {
    handle,
    abort() {
      shutdown.abort();
    },
  };
}

class AbortedError extends Error {
  readonly code: string;

  constructor(why: string) {
    super(why);
    this.name = "AbortedError";
    this.code = `launch_${why}`;
  }
}

/** The stable code of a launch error. Only a code is logged: the text of an error is not ours to trust. */
function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
  )
    return error.code;
  return "launch_error";
}
