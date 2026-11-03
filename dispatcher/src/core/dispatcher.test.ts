// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { createFakeLauncher } from "../launchers/fake.ts";
import { ManualClock, settle } from "../test-support/manual-clock.ts";
import {
  DISPATCHER_TOKEN,
  readContract,
  recordingLogger,
  settingsFor,
  startApp,
  waitFor,
} from "../test-support/harness.ts";
import { createDispatcherCore } from "./dispatcher.ts";
import { createLogger } from "./logger.ts";
import { LaunchError, type HandleResult } from "./types.ts";

let app: DispatcherAppFake;
let clock: ManualClock;

beforeEach(async () => {
  app = await startApp();
  clock = new ManualClock();
});
afterEach(async () => {
  await app.close();
});

type Call = { url: string; method: string; headers: Headers; body: unknown };

/** The real fetch, with a record of what the core sent (the fake App's log has no bodies). */
function recordingFetch() {
  const calls: Call[] = [];
  const fetchRecorded: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.clone().text();
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: text === "" ? null : (JSON.parse(text) as unknown),
    });
    return fetch(request);
  };
  return { calls, fetch: fetchRecorded };
}

function build(
  overrides: Parameters<typeof settingsFor>[1] = {},
  launcherOptions: Parameters<typeof createFakeLauncher>[0] = {},
) {
  const logger = recordingLogger();
  const launcher = createFakeLauncher(launcherOptions);
  const recorded = recordingFetch();
  const core = createDispatcherCore({
    settings: settingsFor(app.url, overrides),
    launcher,
    clock,
    logger,
    fetch: recorded.fetch,
  });
  return { core, launcher, logger, recorded };
}

async function handled(result: Promise<HandleResult>): Promise<HandleResult> {
  const outcome = await result;
  if (outcome.outcome === "started") await outcome.background;
  return outcome;
}

const heartbeats = () =>
  app.requests().filter((request) => request.route === "heartbeat").length;
const releases = () =>
  app.requests().filter((request) => request.route === "release");

/** Moves the clock one heartbeat interval at a time, waiting for each heartbeat to reach the app. */
async function beat(times: number): Promise<void> {
  for (let step = 0; step < times; step += 1) {
    const before = heartbeats();
    await clock.advance(30_000);
    await waitFor(() => heartbeats() > before, "a heartbeat");
    await settle();
  }
}

/** Lets the clock run until the background work of a launch is done (its releases sleep between tries). */
async function drive(background: Promise<void>): Promise<void> {
  let done = false;
  void background.then(() => {
    done = true;
  });
  for (let step = 0; step < 100 && !done; step += 1) {
    await clock.advance(10_000);
    await settle();
  }
  await background;
}

describe("the Dispatcher core", () => {
  // #327-T01
  it("claims exactly the named job with the per-job credential feature and launches it once", async () => {
    const jobId = app.enqueue();
    const { core, launcher, recorded } = build();

    const result = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    const claim = recorded.calls.find((call) => call.url.endsWith("/claim"));
    expect(claim?.body).toStrictEqual({
      engines: ["pr-agent", "opencode"],
      // #498: it also names `vm_lifecycle`, so the App knows its Dispatcher reports the VMs it creates (billable minutes).
      features: ["worker_credential", "vm_lifecycle"],
      jobId,
      maxRunning: 4,
    });
    expect(claim?.headers.get("x-runner-id")).toBe("test-pool");
    expect(claim?.headers.get("authorization")).toBe(
      `Bearer ${DISPATCHER_TOKEN}`,
    );
    expect(launcher.launches).toHaveLength(1);
    expect(launcher.launches[0]).toMatchObject({
      appUrl: app.url,
      jobId,
      kind: "diff",
      timeoutSeconds: 1200,
      config: {},
    });
    expect(launcher.launches[0]?.credential).toMatch(/^crj_[A-Za-z0-9_-]{43}$/);
  });

  // #327-T03
  it("ignores a job the claim does not hand out (a replay, a running or a finished job) and launches nothing", async () => {
    const jobId = app.enqueue();
    const { core, launcher } = build();
    await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    const replay = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(replay).toStrictEqual({ outcome: "ignored" });
    expect(launcher.launches).toHaveLength(1);
  });

  // #327-T04
  it("gives the job back with launch_failed when the launch fails, and the app counts the attempt", async () => {
    const jobId = app.enqueue();
    const { core, launcher, recorded } = build(
      {},
      {
        onLaunch: () =>
          Promise.reject(new LaunchError("sandbox_create_failed")),
      },
    );

    const result = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    const release = recorded.calls.find((call) =>
      call.url.endsWith("/release"),
    );
    expect(release?.url).toBe(
      `${app.url}/api/runners/v1/jobs/${jobId}/release`,
    );
    expect(release?.body).toMatchObject({
      credential: launcher.launches[0]?.credential,
      reason: "launch_failed",
    });
    // The fake App accepts a release only with the claim's own credential; the job is queued again.
    expect(
      app.requests().filter((request) => request.route === "release"),
    ).toStrictEqual([{ method: "POST", route: "release", jobId, status: 200 }]);
    const again = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );
    expect(again.outcome).toBe("started");
  });

  // #327-T05
  it("answers not_capable without a claim when no engine can run the job's kind", async () => {
    const jobId = app.enqueue({ reviewKind: "dynamic" });
    const { core, launcher, recorded } = build({ engines: ["pr-agent"] });

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "dynamic",
    });

    expect(result).toStrictEqual({ outcome: "not_capable" });
    expect(recorded.calls).toStrictEqual([]);
    expect(launcher.launches).toStrictEqual([]);
  });

  // #327-T05
  it("claims with the engines both configured and advertised by the launcher", async () => {
    const jobId = app.enqueue();
    const { core, recorded } = build({}, { engines: ["pr-agent"] });

    await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    const claim = recorded.calls.find((call) => call.url.endsWith("/claim"));
    expect((claim?.body as { engines: string[] }).engines).toStrictEqual([
      "pr-agent",
    ]);
  });

  // #327-T05
  it("fails closed when the launcher cannot tell what it can run", async () => {
    const jobId = app.enqueue();
    const { core, recorded } = build({}, { capabilitiesFail: true });

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });

    expect(result.outcome).toBe("unavailable");
    expect(recorded.calls).toStrictEqual([]);
  });

  // #479-T04
  it("accepts a Dynamic job at once from a Launcher that was never probed: the configured engines and the Launcher decide, nothing waits for a proof", async () => {
    const jobId = app.enqueue({ reviewKind: "dynamic" });
    const { core, launcher, recorded } = build();

    const result = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "dynamic" }),
    );

    expect(result.outcome).toBe("started");
    expect(
      launcher.launches.map((spec) => [spec.jobId, spec.kind]),
    ).toStrictEqual([[jobId, "dynamic"]]);
    expect(launcher.probes).toBe(0);
    const claim = recorded.calls.find((call) => call.url.endsWith("/claim"));
    expect((claim?.body as { engines: string[] }).engines).toStrictEqual([
      "pr-agent",
      "opencode",
    ]);
  });

  // #327-T06
  it("sends the pool cap with the claim and treats 204 at the cap as ignored", async () => {
    const { core, launcher, recorded } = build({ maxRunning: 2 });
    const ids = [app.enqueue(), app.enqueue(), app.enqueue()];
    for (const id of ids.slice(0, 2)) {
      await handled(
        core.handle({ appId: "reviewer", jobId: id, reviewKind: "diff" }),
      );
      await settle();
    }

    const third = await handled(
      core.handle({ appId: "reviewer", jobId: ids[2], reviewKind: "diff" }),
    );

    expect(third).toStrictEqual({ outcome: "ignored" });
    const claims = recorded.calls.filter((call) => call.url.endsWith("/claim"));
    expect(
      claims.map((claim) => (claim.body as { maxRunning: number }).maxRunning),
    ).toStrictEqual([2, 2, 2]);
    expect(launcher.launches).toHaveLength(2);
  });

  // #327-T06
  it("does not claim more jobs at once than the cap while launches are in progress", async () => {
    const jobs = [app.enqueue(), app.enqueue()];
    const { core } = build(
      { maxRunning: 1 },
      {
        onLaunch: (_spec, signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
      },
    );

    const first = await core.handle({
      appId: "reviewer",
      jobId: jobs[0],
      reviewKind: "diff",
    });
    const second = await core.handle({
      appId: "reviewer",
      jobId: jobs[1],
      reviewKind: "diff",
    });

    expect(first.outcome).toBe("started");
    expect(second).toMatchObject({ outcome: "busy" });
    expect(app.requests().filter((r) => r.route === "claim")).toHaveLength(1);
    core.abort();
    if (first.outcome === "started") await first.background;
  });

  // #327-T07
  it("never writes the credential or the dispatcher token into logs, results or errors", async () => {
    const jobId = app.enqueue();
    const failing = build(
      {},
      {
        // The worst case: a launcher whose error text carries the credential and the token.
        onLaunch: (spec) =>
          Promise.reject(
            new Error(
              `docker run failed for ${spec.credential} with Bearer ${DISPATCHER_TOKEN} and ${DISPATCHER_TOKEN}`,
            ),
          ),
      },
    );

    const result = await handled(
      failing.core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    const credential = failing.launcher.launches[0]?.credential ?? "";
    expect(credential).not.toBe("");
    const everything = `${failing.logger.text()}\n${JSON.stringify(result)}`;
    expect(everything).not.toContain(credential);
    expect(everything).not.toContain(DISPATCHER_TOKEN);
    expect(everything).not.toMatch(/crj_[A-Za-z0-9_-]{10,}/);
    expect(failing.logger.text()).toContain("launch_failed");
  });

  // #327-T07
  it("never logs the credential when the app misbehaves or the lease is lost", async () => {
    const jobId = app.enqueue();
    app.script("release", [{ status: 503 }, { status: 503 }, { status: 503 }]);
    const { core, launcher, logger } = build(
      {},
      { onLaunch: () => Promise.reject(new LaunchError("boom")) },
    );

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });
    if (result.outcome === "started") await drive(result.background);

    const credential = launcher.launches[0]?.credential ?? "";
    expect(logger.text()).not.toContain(credential);
    expect(logger.text()).not.toContain(DISPATCHER_TOKEN);
  });

  // #327-T08
  it("heartbeats with the job credential while the launch takes longer than the lease", async () => {
    const jobId = app.enqueue();
    let finishLaunch: () => void = () => undefined;
    const { core, launcher } = build(
      {},
      {
        onLaunch: () =>
          new Promise<void>((resolve) => {
            finishLaunch = resolve;
          }),
      },
    );

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });
    await settle();
    await beat(5);
    finishLaunch();
    if (result.outcome === "started") await result.background;

    const requests = app.requests();
    expect(
      requests
        .filter((r) => r.route === "heartbeat")
        .every((r) => r.status === 200 && r.jobId === jobId),
    ).toBe(true);
    expect(requests.filter((r) => r.route === "heartbeat")).toHaveLength(5);
    expect(requests.filter((r) => r.route === "release")).toStrictEqual([]);
    expect(launcher.signals[0]?.aborted).toBe(false);
  });

  // #327-T08
  it("stops heartbeating once the Worker has taken over", async () => {
    const jobId = app.enqueue();
    const { core } = build();

    await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );
    const before = heartbeats();
    await clock.advance(120_000);
    await settle();

    expect(heartbeats()).toBe(before);
  });

  // #327-T08
  it("gives up at the five minute deadline: the launch is aborted and the job released", async () => {
    const jobId = app.enqueue();
    const { core, launcher } = build(
      {},
      {
        onLaunch: (_spec, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () =>
              reject(new LaunchError("aborted")),
            ),
          ),
      },
    );

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });
    await settle();
    await beat(9);
    await clock.advance(29_000);
    expect(launcher.signals[0]?.aborted).toBe(false);
    expect(releases()).toStrictEqual([]);
    await clock.advance(1_000);
    if (result.outcome === "started") await drive(result.background);

    expect(launcher.signals[0]?.aborted).toBe(true);
    expect(app.requests().filter((r) => r.route === "release")).toStrictEqual([
      { method: "POST", route: "release", jobId, status: 200 },
    ]);
  });

  // #327-T08
  it("gives up at the deadline even when the launcher ignores the abort signal", async () => {
    const jobId = app.enqueue();
    const { core } = build(
      {},
      { onLaunch: () => new Promise<void>(() => undefined) },
    );

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });
    await settle();
    await beat(9);
    await clock.advance(30_000);
    if (result.outcome === "started") await drive(result.background);

    expect(releases()).toHaveLength(1);
  });

  // #327-T08
  it("stops the launch and releases nothing when the lease is lost (the app no longer knows the credential)", async () => {
    const jobId = app.enqueue();
    const { core, launcher, logger } = build(
      {},
      {
        onLaunch: (_spec, signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
      },
    );

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });
    await settle();
    app.loseLease(jobId);
    await clock.advance(30_000);
    if (result.outcome === "started") await drive(result.background);

    expect(launcher.signals[0]?.aborted).toBe(true);
    expect(releases()).toStrictEqual([]);
    expect(logger.text()).toContain("lease_lost");
  });

  // #327 (additional): mixed versions
  it("refuses to claim against an app that lacks a feature the split needs", async () => {
    const jobId = app.enqueue();
    app.script("version", [
      {
        status: 200,
        body: { version: 1, appVersion: "0.0.1", features: ["worker_api"] },
      },
    ]);
    const { core, launcher } = build();

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });

    expect(result).toMatchObject({ outcome: "unavailable" });
    expect(app.requests().filter((r) => r.route === "claim")).toStrictEqual([]);
    expect(launcher.launches).toStrictEqual([]);
  });

  // #327 (additional): mixed versions
  it("refuses an app that has no version route at all (a previous release)", async () => {
    const jobId = app.enqueue();
    app.script("version", [{ status: 404 }]);
    const { core } = build();

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });

    expect(result).toMatchObject({ outcome: "unavailable" });
    expect(app.requests().filter((r) => r.route === "claim")).toStrictEqual([]);
  });

  // #327 (additional): mixed versions
  it("never keeps or logs a legacy claim answer (job input, git token) a previous release sends", async () => {
    const jobId = app.enqueue();
    const legacy = readContract<{ job: { leaseToken: string } }>(
      "examples/ClaimResponse.json",
    );
    app.script("claim", [{ status: 200, body: legacy }]);
    const { core, launcher, logger } = build();

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });

    expect(result).toMatchObject({ outcome: "unavailable" });
    expect(launcher.launches).toStrictEqual([]);
    expect(logger.text()).not.toContain(legacy.job.leaseToken);
  });

  // #327 (additional): the version is read once and remembered
  it("asks the app for its version once, not for every wake-up call", async () => {
    const first = app.enqueue();
    const second = app.enqueue();
    const { core } = build();

    await handled(
      core.handle({ appId: "reviewer", jobId: first, reviewKind: "diff" }),
    );
    await handled(
      core.handle({ appId: "reviewer", jobId: second, reviewKind: "diff" }),
    );

    expect(app.requests().filter((r) => r.route === "version")).toHaveLength(1);
  });

  // #327 (additional): the app is down or busy
  it.each([
    [503, 17, "unavailable", 17],
    [429, 9, "busy", 9],
    [500, undefined, "unavailable", 60],
    [401, undefined, "unavailable", 300],
  ] as const)(
    "maps a %i from the claim to %s with a retry hint",
    async (status, retryAfterSeconds, outcome, expected) => {
      const jobId = app.enqueue();
      app.script("claim", [{ status, retryAfterSeconds }]);
      const { core, launcher } = build();

      const result = await core.handle({
        appId: "reviewer",
        jobId,
        reviewKind: "diff",
      });

      expect(result).toStrictEqual({ outcome, retryAfterSeconds: expected });
      expect(launcher.launches).toStrictEqual([]);
    },
  );

  // #327 (additional): the app does not answer
  it("answers unavailable when the app cannot be reached", async () => {
    const jobId = app.enqueue();
    const { core } = build({ appUrl: "http://127.0.0.1:1" });

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });

    expect(result).toMatchObject({ outcome: "unavailable" });
  });

  // #327 (additional): the job kind decides the Worker's configuration
  it("passes the configuration of the job's kind to the launcher", async () => {
    const jobId = app.enqueue({ reviewKind: "dynamic" });
    const { core, launcher } = build({
      workerConfig: {
        diff: {},
        dynamic: { container: { memory: { limit: "1500m" } } },
      },
    });

    await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "dynamic" }),
    );

    expect(launcher.launches[0]).toMatchObject({
      kind: "dynamic",
      config: { container: { memory: { limit: "1500m" } } },
    });
  });

  // #327 (additional): graceful shutdown
  it("aborts the launches in progress and releases their jobs on shutdown", async () => {
    const jobId = app.enqueue();
    const { core, launcher } = build(
      {},
      {
        onLaunch: (_spec, signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
      },
    );
    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });
    await settle();

    core.abort();
    if (result.outcome === "started") await result.background;

    expect(launcher.signals[0]?.aborted).toBe(true);
    expect(app.requests().filter((r) => r.route === "release")).toHaveLength(1);
  });
});

/**
 * The release of a job whose launch failed (`launch_failed`): the only path left that gives a job back (#487). Its
 * answers were first proven through the end of the Worker's container (#375), which the Dispatcher no longer watches.
 */
describe("the Dispatcher core when it gives a failed launch back", () => {
  const launchFails = () =>
    Promise.reject(new LaunchError("sandbox_create_failed"));

  /** What the Worker does with its credential: deliver its result. */
  async function deliverResult(jobId: string, credential: string) {
    const response = await fetch(
      `${app.url}/api/workers/v1/jobs/${jobId}/result`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ result: { ok: true } }),
      },
    );
    expect(response.status).toBe(200);
  }

  // #375-T03
  it("treats the release of a job that already delivered its result as a no-op: one call, no retry, the result stands", async () => {
    const jobId = app.enqueue();
    const { core, logger } = build(
      {},
      {
        // The Worker delivers a result, then the launch still ends in an error.
        onLaunch: async (spec) => {
          await deliverResult(jobId, spec.credential);
          throw new LaunchError("sandbox_create_failed");
        },
      },
    );

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });
    if (result.outcome === "started") await drive(result.background);

    expect(releases()).toStrictEqual([
      { method: "POST", route: "release", jobId, status: 409 },
    ]);
    // Expected, so not a warning: a refusal of the claim is one.
    expect(
      logger.lines.some((line) => line.startsWith("info release_job_ended")),
    ).toBe(true);
    expect(logger.text()).not.toContain("release_not_holder");
    expect(logger.text()).not.toContain("release_failed");
    expect(logger.text()).not.toContain('"released"');
    expect(app.results(jobId)).toHaveLength(1);
    // The job is finished, not queued: nothing is claimed for it.
    expect(
      (await core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }))
        .outcome,
    ).toBe("ignored");
  });

  // #375-T06 (the Dispatcher's side: a stale credential after a requeue and a new claim)
  it("does not take the job from a newer claim when its own credential is stale", async () => {
    const jobId = app.enqueue();
    let failLaunch: () => void = () => undefined;
    const first = build(
      {},
      {
        onLaunch: () =>
          new Promise<void>((_resolve, reject) => {
            failLaunch = () => reject(new LaunchError("sandbox_create_failed"));
          }),
      },
    );
    const started = await first.core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });
    expect(started.outcome).toBe("started");
    const staleCredential = first.launcher.launches[0]?.credential ?? "";
    // The first claim ends (the job is given back by someone else), a second claim starts.
    const given = await fetch(
      `${app.url}/api/runners/v1/jobs/${jobId}/release`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${DISPATCHER_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          credential: staleCredential,
          reason: "worker_exited",
          retryAfterSeconds: 30,
        }),
      },
    );
    expect(given.status).toBe(200);
    const second = build();
    expect(
      (
        await handled(
          second.core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
        )
      ).outcome,
    ).toBe("started");
    expect(second.launcher.launches[0]?.credential).not.toBe(staleCredential);
    const before = releases().length;

    // The first launch fails late: its credential is not the claim's any more.
    failLaunch();
    if (started.outcome === "started") await drive(started.background);

    expect(releases().slice(before)).toStrictEqual([
      { method: "POST", route: "release", jobId, status: 401 },
    ]);
    expect(
      first.logger.lines.some((line) =>
        line.startsWith("warn release_not_holder"),
      ),
    ).toBe(true);
    // The new claim is untouched: the job is still running for it, and nothing is claimed twice.
    expect(
      (
        await second.core.handle({
          appId: "reviewer",
          jobId,
          reviewKind: "diff",
        })
      ).outcome,
    ).toBe("ignored");
  });

  // #375-T07
  it("tries the release a bounded number of times, logs release_failed with its reason, and leaves the job to its lease", async () => {
    const jobId = app.enqueue();
    app.script("release", [
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
    ]);
    const { core, logger } = build({}, { onLaunch: launchFails });

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });
    if (result.outcome === "started") await drive(result.background);
    await clock.advance(10 * 60 * 1000);
    await settle();

    expect(releases().map((request) => request.status)).toStrictEqual([
      503, 503, 503,
    ]);
    expect(logger.text()).toContain("release_failed");
    expect(logger.text()).toContain('"reason":"launch_failed"');
  });

  // #375-T07
  it("does not reject when the App cannot be reached", async () => {
    const jobId = app.enqueue();
    const { core, logger } = build(
      {},
      {
        onLaunch: async () => {
          await app.close();
          throw new LaunchError("sandbox_create_failed");
        },
      },
    );

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });
    expect(result.outcome).toBe("started");
    if (result.outcome === "started")
      await expect(drive(result.background)).resolves.toBeUndefined();

    expect(logger.text()).toContain("release_failed");
    // Start the next test's app again: afterEach closes it, and a closed server is closed once.
    app = await startApp();
  });

  // #375-T08
  it("never writes the credential or the dispatcher token on any path of the release, through the real masker", async () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line), [DISPATCHER_TOKEN]);
    const credentials: string[] = [];
    const launcher = createFakeLauncher({
      onLaunch: async (spec) => {
        credentials.push(spec.credential);
        // The ended job delivers its result before its launch fails; the others fail at once.
        if (spec.jobId === ended) await deliverResult(ended, spec.credential);
        throw new LaunchError("sandbox_create_failed");
      },
    });
    const core = createDispatcherCore({
      settings: settingsFor(app.url),
      launcher,
      clock,
      logger,
    });
    const [released, refused, failing] = [
      app.enqueue(),
      app.enqueue(),
      app.enqueue(),
    ];
    const ended = app.enqueue();

    // Every outcome of the release: released, job ended, refused (the claim is gone), a failing App.
    for (const jobId of [released, ended]) {
      const result = await core.handle({
        appId: "reviewer",
        jobId,
        reviewKind: "diff",
      });
      if (result.outcome === "started") await drive(result.background);
    }
    app.script("release", [{ status: 401 }]);
    const refusedResult = await core.handle({
      appId: "reviewer",
      jobId: refused,
      reviewKind: "diff",
    });
    if (refusedResult.outcome === "started")
      await drive(refusedResult.background);
    app.script("release", [{ status: 503 }, { status: 503 }, { status: 503 }]);
    const failingResult = await core.handle({
      appId: "reviewer",
      jobId: failing,
      reviewKind: "diff",
    });
    if (failingResult.outcome === "started")
      await drive(failingResult.background);

    const everything = lines.join("\n");
    expect(everything).toContain("launch_failed");
    for (const event of [
      '"released"',
      "release_job_ended",
      "release_not_holder",
      "release_failed",
    ])
      expect(everything).toContain(event);
    expect(credentials).toHaveLength(4);
    for (const credential of credentials)
      expect(everything).not.toContain(credential);
    expect(everything).not.toContain(DISPATCHER_TOKEN);
    expect(everything).not.toMatch(/crj_[A-Za-z0-9_-]{10,}/);
  });
});

describe("the Dispatcher core after the hand-over", () => {
  // #487-T04
  it("ends its work when the launch resolves: no callback for the end of the Worker, no heartbeat, no release", async () => {
    const jobId = app.enqueue();
    const { core, launcher } = build();

    const result = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    const spec = launcher.launches[0];
    expect(spec).toBeDefined();
    // The Launcher is given nothing to call when the Worker's container ends: nobody supervises it.
    expect(Object.keys(spec ?? {})).not.toContain("onWorkerExit");
    const requests = app.requests().length;
    await clock.advance(10 * 60_000);
    await settle();
    expect(app.requests()).toHaveLength(requests);
    expect(releases()).toStrictEqual([]);
  });
});

describe("the network rule of a job (#745, step 7)", () => {
  const buildAll = () =>
    build(
      {
        engines: ["pr-agent", "opencode", "implementer"],
        kinds: ["diff", "dynamic", "implementer"],
      },
      { engines: ["pr-agent", "opencode", "implementer"] },
    );
  const LIST = { mode: "list", hosts: ["registry.npmjs.org"] };

  // #745-T33
  it("passes the rule the App names for a job of the Implementer to the Launcher, and for nothing else", async () => {
    const withRule = app.enqueue({ reviewKind: "implementer", network: LIST });
    const without = app.enqueue({ reviewKind: "implementer" });
    const { core, launcher } = buildAll();

    await handled(
      core.handle({
        appId: "reviewer",
        jobId: withRule,
        reviewKind: "implementer",
      }),
    );
    await handled(
      core.handle({
        appId: "reviewer",
        jobId: without,
        reviewKind: "implementer",
      }),
    );

    expect(launcher.launches[0]?.network).toStrictEqual(LIST);
    expect(launcher.launches[1]?.network).toBeUndefined();
  });

  // #745-T33
  it.each(["diff", "dynamic"] as const)(
    "never hands a %s job's rule to the Launcher, even when the App's answer names one",
    async (reviewKind) => {
      const jobId = app.enqueue({ reviewKind, network: LIST });
      const { core, launcher } = buildAll();

      await handled(core.handle({ appId: "reviewer", jobId, reviewKind }));

      expect(launcher.launches).toHaveLength(1);
      expect(launcher.launches[0]?.network).toBeUndefined();
    },
  );

  // #745-T33
  it.each([
    ["a mode that is not one", { mode: "closed", hosts: [] }],
    ["a list with no host", { mode: "list", hosts: [] }],
    ["hosts for an open rule", { mode: "open", hosts: ["a.example.com"] }],
    ["an address as a host", { mode: "list", hosts: ["10.0.0.1"] }],
    ["text", "open"],
    ["null", null],
  ])(
    "treats a claim answer whose rule is %s as an answer it cannot read: nothing is launched",
    async (_name, network) => {
      const jobId = app.enqueue({ reviewKind: "implementer", network });
      const { core, launcher } = buildAll();

      await handled(
        core.handle({ appId: "reviewer", jobId, reviewKind: "implementer" }),
      );

      expect(launcher.launches).toStrictEqual([]);
    },
  );
});

describe("the size of a job (#818)", () => {
  /** A core that serves the Implementer as well as the reviews. */
  const buildAll = () =>
    build(
      {
        engines: ["pr-agent", "opencode", "implementer"],
        kinds: ["diff", "dynamic", "implementer"],
      },
      { engines: ["pr-agent", "opencode", "implementer"] },
    );
  // #818-T36
  it("passes the size the App names for a job of the Implementer to the Launcher, and for nothing else", async () => {
    const withSize = app.enqueue({ reviewKind: "implementer", vcpus: 6 });
    const withoutSize = app.enqueue({ reviewKind: "implementer" });
    const { core, launcher } = buildAll();

    await handled(
      core.handle({
        appId: "reviewer",
        jobId: withSize,
        reviewKind: "implementer",
      }),
    );
    await handled(
      core.handle({
        appId: "reviewer",
        jobId: withoutSize,
        reviewKind: "implementer",
      }),
    );

    expect(launcher.launches[0]?.vcpus).toBe(6);
    expect(launcher.launches[1]?.vcpus).toBeUndefined();
  });

  // #818-T36
  it.each(["diff", "dynamic"] as const)(
    "never hands a %s job's size to the Launcher, even when the App's answer names one",
    async (reviewKind) => {
      const jobId = app.enqueue({ reviewKind, vcpus: 8 });
      const { core, launcher } = buildAll();

      await handled(core.handle({ appId: "reviewer", jobId, reviewKind }));

      expect(launcher.launches).toHaveLength(1);
      expect(launcher.launches[0]?.vcpus).toBeUndefined();
    },
  );

  // #818-T36
  it.each([
    ["text", "4"],
    ["a fraction", 2.5],
    ["null", null],
    ["an object", {}],
  ])(
    "treats a claim answer whose size is %s as an answer it cannot read: nothing is launched",
    async (_name, vcpus) => {
      const jobId = app.enqueue({ reviewKind: "implementer", vcpus });
      const { core, launcher } = buildAll();

      const result = await handled(
        core.handle({ appId: "reviewer", jobId, reviewKind: "implementer" }),
      );

      expect(result.outcome).not.toBe("started");
      expect(launcher.launches).toHaveLength(0);
    },
  );
});
