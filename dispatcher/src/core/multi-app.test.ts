// SPDX-License-Identifier: LicenseRef-Proprietary

// The core with several apps (#730): every call is claimed at the app it names and nowhere else, each app has its own
// credential, pool, cap and version memory, and a kind the app may not have is refused before and after the claim.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { createFakeLauncher } from "../launchers/fake.ts";
import { ManualClock, settle } from "../test-support/manual-clock.ts";
import {
  DISPATCHER_TOKEN,
  recordingLogger,
  settingsFor,
  startApp,
  waitFor,
} from "../test-support/harness.ts";
import { createDispatcherCore } from "./dispatcher.ts";
import {
  LaunchError,
  type AppSettings,
  type CoreSettings,
  type CreatedVm,
  type HandleResult,
  type LiveVmCounter,
} from "./types.ts";

const FACTORY_TOKEN = "dummy-factory-dispatcher-token-for-tests";

let reviewer: DispatcherAppFake;
let factory: DispatcherAppFake;
let clock: ManualClock;

beforeEach(async () => {
  reviewer = await startApp();
  factory = await startApp({ dispatcherToken: FACTORY_TOKEN });
  clock = new ManualClock();
});
afterEach(async () => {
  await reviewer.close();
  await factory.close();
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

function factoryApp(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    id: "factory",
    url: factory.url,
    token: FACTORY_TOKEN,
    poolId: "factory-pool",
    maxRunning: 2,
    kinds: ["diff", "dynamic"],
    ...overrides,
  };
}

function build(
  options: {
    factory?: Partial<AppSettings>;
    reviewer?: { maxRunning?: number };
    launcher?: Parameters<typeof createFakeLauncher>[0];
    liveVms?: LiveVmCounter;
  } = {},
) {
  const logger = recordingLogger();
  const launcher = createFakeLauncher(options.launcher);
  const recorded = recordingFetch();
  const core = createDispatcherCore({
    settings: settingsFor(reviewer.url, {
      ...options.reviewer,
      more: [factoryApp(options.factory)],
    }),
    launcher,
    clock,
    logger,
    fetch: recorded.fetch,
    now: () => clock.now(),
    ...(options.liveVms === undefined ? {} : { liveVms: options.liveVms }),
  });
  return { core, launcher, logger, recorded };
}

async function handled(result: Promise<HandleResult>): Promise<HandleResult> {
  const outcome = await result;
  if (outcome.outcome === "started") await outcome.background;
  return outcome;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const seen = (app: DispatcherAppFake, route: string) =>
  app.requests().filter((request) => request.route === route);

describe("the core with several apps", () => {
  // #730-T03
  it("claims a job of the factory at the factory's address with the factory's credential and pool, and does not call the reviewer", async () => {
    const jobId = factory.enqueue();
    const { core, launcher, recorded } = build();

    const result = await handled(
      core.handle({ appId: "factory", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    const claims = recorded.calls.filter((call) => call.url.endsWith("/claim"));
    expect(claims).toHaveLength(1);
    expect(claims[0]?.url.startsWith(factory.url)).toBe(true);
    expect(claims[0]?.headers.get("authorization")).toBe(
      `Bearer ${FACTORY_TOKEN}`,
    );
    expect(claims[0]?.headers.get("x-runner-id")).toBe("factory-pool");
    expect(claims[0]?.body).toMatchObject({ jobId, maxRunning: 2 });
    expect(reviewer.requests()).toHaveLength(0);
    expect(launcher.launches).toHaveLength(1);
  });

  // #730-T26
  it("keeps the leading fields of the `launched` line, which the hosted E2E reads, and adds the app after them", async () => {
    const jobId = reviewer.enqueue();
    const { core, logger } = build();

    await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(
      logger.lines.some((line) =>
        line.startsWith(
          `info launched {"jobId":"${jobId}","kind":"diff","ms":`,
        ),
      ),
    ).toBe(true);
    expect(logger.text()).toContain('"app":"reviewer"}');
  });

  // #730-T03
  it("claims a job of the reviewer at the reviewer's address with the reviewer's credential, and does not call the factory", async () => {
    const jobId = reviewer.enqueue();
    const { core, recorded } = build();

    const result = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    const claim = recorded.calls.find((call) => call.url.endsWith("/claim"));
    expect(claim?.url.startsWith(reviewer.url)).toBe(true);
    expect(claim?.headers.get("authorization")).toBe(
      `Bearer ${DISPATCHER_TOKEN}`,
    );
    expect(claim?.headers.get("x-runner-id")).toBe("test-pool");
    expect(factory.requests()).toHaveLength(0);
  });

  // #730-T03
  it("does not claim a job of the reviewer through the factory's key: the factory's claim sees only the factory's jobs", async () => {
    const jobId = reviewer.enqueue();
    const { core, launcher } = build();

    const result = await handled(
      core.handle({ appId: "factory", jobId, reviewKind: "diff" }),
    );

    expect(result).toStrictEqual({ outcome: "ignored" });
    expect(launcher.launches).toHaveLength(0);
    expect(seen(reviewer, "claim")).toHaveLength(0);
    expect(reviewer.requests()).toHaveLength(0);
  });

  // #730-T04
  it("answers `ignored` for a 204 of the factory's claim and makes no call to the other app", async () => {
    const { core, launcher } = build();
    // The factory has no such job: its claim answers 204. The reviewer has one with the same id.
    const jobId = reviewer.enqueue({
      id: "00000000-0000-4000-8000-0000000000aa",
    });

    const result = await handled(
      core.handle({ appId: "factory", jobId, reviewKind: "diff" }),
    );

    expect(result).toStrictEqual({ outcome: "ignored" });
    expect(seen(factory, "claim")).toHaveLength(1);
    expect(reviewer.requests()).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
  });

  // #730-T06
  it("hands the Launcher the factory's registry address and its job credential, and the app id", async () => {
    const jobId = factory.enqueue();
    const { core, launcher } = build();

    await handled(core.handle({ appId: "factory", jobId, reviewKind: "diff" }));

    expect(launcher.launches[0]).toMatchObject({
      appId: "factory",
      appUrl: factory.url,
      jobId,
      kind: "diff",
    });
    expect(launcher.launches[0]?.credential).toMatch(/^crj_[A-Za-z0-9_-]{43}$/);
  });

  // #730-T06
  it("sends the heartbeats of a factory job, its release and its VM report to the factory only", async () => {
    const jobId = factory.enqueue();
    const hold = deferred();
    const { core } = build({
      launcher: {
        onLaunch: async (spec) => {
          spec.onVmCreated?.({
            name: "cr-diff-vm",
            startedAt: new Date("2026-10-10T12:00:00Z"),
            timeoutSeconds: 1500,
          });
          await hold.promise;
          throw new LaunchError("sandbox_create_failed");
        },
      },
    });

    const result = await core.handle({
      appId: "factory",
      jobId,
      reviewKind: "diff",
    });
    expect(result.outcome).toBe("started");
    await clock.advance(30_000);
    await waitFor(() => seen(factory, "heartbeat").length > 0, "a heartbeat");
    await settle();
    hold.resolve();
    if (result.outcome === "started") {
      for (let step = 0; step < 100; step += 1) {
        await clock.advance(10_000);
        await settle();
      }
      await result.background;
    }

    expect(seen(factory, "heartbeat").length).toBeGreaterThan(0);
    expect(seen(factory, "vm")).toHaveLength(1);
    expect(factory.vms(jobId)).toHaveLength(1);
    expect(seen(factory, "release")).toHaveLength(1);
    // Not one of those reached the reviewer.
    expect(reviewer.requests()).toHaveLength(0);
  });

  // #730-T07
  it("gives each app its own cap: the factory at its cap answers `busy` and does not take a reviewer slot", async () => {
    const ids = [
      factory.enqueue({ id: "00000000-0000-4000-8000-0000000000b1" }),
      factory.enqueue({ id: "00000000-0000-4000-8000-0000000000b2" }),
      reviewer.enqueue({ id: "00000000-0000-4000-8000-0000000000c1" }),
      reviewer.enqueue({ id: "00000000-0000-4000-8000-0000000000c2" }),
    ] as const;
    const hold = deferred();
    const { core, launcher, logger } = build({
      factory: { maxRunning: 1 },
      reviewer: { maxRunning: 2 },
      launcher: { onLaunch: () => hold.promise },
    });

    const first = await core.handle({
      appId: "factory",
      jobId: ids[0],
      reviewKind: "diff",
    });
    const second = await core.handle({
      appId: "factory",
      jobId: ids[1],
      reviewKind: "diff",
    });
    // The factory is full; the reviewer still has both of its slots.
    const third = await core.handle({
      appId: "reviewer",
      jobId: ids[2],
      reviewKind: "diff",
    });
    const fourth = await core.handle({
      appId: "reviewer",
      jobId: ids[3],
      reviewKind: "diff",
    });

    expect(first.outcome).toBe("started");
    expect(second).toStrictEqual({ outcome: "busy", retryAfterSeconds: 30 });
    expect(third.outcome).toBe("started");
    expect(fourth.outcome).toBe("started");
    expect(launcher.launches).toHaveLength(3);
    // The ceiling is the sum of the caps: 1 + 2 launches in progress, never more.
    expect(logger.text()).toContain('busy {"app":"factory"');
    // The factory's busy claim reached nobody: its second job was not even claimed.
    expect(seen(factory, "claim")).toHaveLength(1);

    const fifth = await core.handle({
      appId: "reviewer",
      jobId: reviewer.enqueue({ id: "00000000-0000-4000-8000-0000000000c3" }),
      reviewKind: "diff",
    });
    expect(fifth).toStrictEqual({ outcome: "busy", retryAfterSeconds: 30 });
    expect(launcher.launches).toHaveLength(3);

    hold.resolve();
    for (const result of [first, third, fourth])
      if (result.outcome === "started") await result.background;
  });

  // #730-T07
  it("sends each app's own cap with its claim", async () => {
    const { core, recorded } = build({
      factory: { maxRunning: 3 },
      reviewer: { maxRunning: 5 },
    });

    await handled(
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );
    await handled(
      core.handle({
        appId: "reviewer",
        jobId: reviewer.enqueue(),
        reviewKind: "diff",
      }),
    );

    const caps = recorded.calls
      .filter((call) => call.url.endsWith("/claim"))
      .map((call) => [
        new URL(call.url).origin,
        (call.body as { maxRunning: number }).maxRunning,
      ]);
    expect(caps).toStrictEqual([
      [new URL(factory.url).origin, 3],
      [new URL(reviewer.url).origin, 5],
    ]);
  });

  // #730-T08
  it("remembers the version answer per app: a factory that is too old does not block the reviewer, and is asked again", async () => {
    factory.script("version", [{ status: 404 }]);
    const { core, logger } = build();

    const tooOld = await core.handle({
      appId: "factory",
      jobId: factory.enqueue(),
      reviewKind: "diff",
    });
    const reviewerOne = await handled(
      core.handle({
        appId: "reviewer",
        jobId: reviewer.enqueue(),
        reviewKind: "diff",
      }),
    );
    const reviewerTwo = await handled(
      core.handle({
        appId: "reviewer",
        jobId: reviewer.enqueue(),
        reviewKind: "diff",
      }),
    );
    const factoryAgain = await handled(
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );

    expect(tooOld).toMatchObject({ outcome: "unavailable" });
    expect(logger.text()).toContain('app_unsupported {"app":"factory"');
    expect(reviewerOne.outcome).toBe("started");
    expect(reviewerTwo.outcome).toBe("started");
    // The reviewer's answer is remembered (one question for two jobs); the factory's failure was not.
    expect(seen(reviewer, "version")).toHaveLength(1);
    expect(factoryAgain.outcome).toBe("started");
    expect(seen(factory, "version")).toHaveLength(2);
  });

  // #730-T09
  it("answers `not_capable` for a kind outside the app's kinds and makes no claim and no call at all", async () => {
    const jobId = factory.enqueue({ reviewKind: "dynamic" });
    const { core, launcher, logger } = build({ factory: { kinds: ["diff"] } });

    const result = await core.handle({
      appId: "factory",
      jobId,
      reviewKind: "dynamic",
    });

    expect(result).toStrictEqual({ outcome: "not_capable" });
    expect(logger.text()).toContain("kind_not_allowed");
    expect(factory.requests()).toHaveLength(0);
    expect(reviewer.requests()).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
  });

  // #730-T09
  it("asks for the engines of the app's kinds only", async () => {
    const { core, recorded } = build({ factory: { kinds: ["diff"] } });

    await handled(
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );
    await handled(
      core.handle({
        appId: "reviewer",
        jobId: reviewer.enqueue(),
        reviewKind: "diff",
      }),
    );

    const claims = recorded.calls.filter((call) => call.url.endsWith("/claim"));
    expect(
      claims.map((call) => (call.body as { engines: string[] }).engines),
    ).toStrictEqual([["pr-agent"], ["pr-agent", "opencode"]]);
  });

  // #730-T10
  it("releases a claimed job of a disallowed kind, logs `kind_not_allowed` as an error and creates no VM", async () => {
    const jobId = "00000000-0000-4000-8000-0000000000d1";
    factory.enqueue({ id: jobId, reviewKind: "dynamic" });
    // An App that hands out a dynamic job although the Dispatcher asked for Diff engines only.
    factory.script("claim", [
      {
        status: 200,
        body: {
          version: 1,
          job: {
            id: jobId,
            credential: `crj_${"A".repeat(43)}`,
            reviewKind: "dynamic",
            leaseExpiresAt: "2026-10-10T12:02:00.000Z",
            heartbeatIntervalSeconds: 30,
          },
        },
      },
    ]);
    const { core, launcher, logger } = build({ factory: { kinds: ["diff"] } });

    const done = core.handle({
      appId: "factory",
      jobId,
      reviewKind: "diff",
    });
    const result = await (async () => {
      let value: HandleResult | undefined;
      void done.then((answer) => {
        value = answer;
      });
      for (let step = 0; step < 100 && value === undefined; step += 1) {
        await clock.advance(1000);
        await settle();
      }
      return done;
    })();

    expect(result).toStrictEqual({ outcome: "not_capable" });
    expect(launcher.launches).toHaveLength(0);
    expect(seen(factory, "release").length).toBeGreaterThan(0);
    expect(reviewer.requests()).toHaveLength(0);
    expect(
      logger.lines.some((line) => line.startsWith("error kind_not_allowed")),
    ).toBe(true);
    expect(logger.text()).not.toContain("crj_");
  });

  // #746-T07
  it("answers `not_capable` for a wake-up of the implementer kind and makes no claim and no call", async () => {
    const jobId = "00000000-0000-4000-8000-0000000000e1";
    const { core, launcher } = build();

    const result = await core.handle({
      appId: "factory",
      jobId,
      reviewKind: "implementer",
    });

    // No engine of this Dispatcher runs the kind (P14 adds it): it is never mapped onto another engine.
    expect(result).toStrictEqual({ outcome: "not_capable" });
    expect(factory.requests()).toHaveLength(0);
    expect(reviewer.requests()).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
  });

  // #746-T07
  it("releases a claimed job of the implementer kind unlaunched, whatever kinds the app has", async () => {
    const jobId = "00000000-0000-4000-8000-0000000000e2";
    factory.enqueue({ id: jobId });
    factory.script("claim", [
      {
        status: 200,
        body: {
          version: 1,
          job: {
            id: jobId,
            credential: `crj_${"A".repeat(43)}`,
            reviewKind: "implementer",
            leaseExpiresAt: "2026-10-10T12:02:00.000Z",
            heartbeatIntervalSeconds: 30,
          },
        },
      },
    ]);
    const { core, launcher, logger } = build();

    const done = core.handle({ appId: "factory", jobId, reviewKind: "diff" });
    const result = await (async () => {
      let value: HandleResult | undefined;
      void done.then((answer) => {
        value = answer;
      });
      for (let step = 0; step < 100 && value === undefined; step += 1) {
        await clock.advance(1000);
        await settle();
      }
      return done;
    })();

    expect(result).toStrictEqual({ outcome: "not_capable" });
    expect(launcher.launches).toHaveLength(0);
    expect(seen(factory, "release").length).toBeGreaterThan(0);
    expect(
      logger.lines.some((line) => line.startsWith("error kind_not_allowed")),
    ).toBe(true);
    expect(logger.text()).not.toContain("crj_");
  });

  // #730-T10
  it("gives back the slot of a job it refused", async () => {
    const jobId = "00000000-0000-4000-8000-0000000000d2";
    factory.script("claim", [
      {
        status: 200,
        body: {
          version: 1,
          job: {
            id: jobId,
            credential: `crj_${"B".repeat(43)}`,
            reviewKind: "dynamic",
            leaseExpiresAt: "2026-10-10T12:02:00.000Z",
            heartbeatIntervalSeconds: 30,
          },
        },
      },
    ]);
    const { core } = build({ factory: { kinds: ["diff"], maxRunning: 1 } });

    const refused = core.handle({
      appId: "factory",
      jobId,
      reviewKind: "diff",
    });
    for (let step = 0; step < 100; step += 1) {
      await clock.advance(1000);
      await settle();
    }
    await refused;
    const next = await handled(
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );

    expect(next.outcome).toBe("started");
  });

  // #730-T03
  it("refuses a call that names an app it does not serve, with no call to any app", async () => {
    const { core } = build();

    const result = await core.handle({
      appId: "stranger",
      jobId: reviewer.enqueue(),
      reviewKind: "diff",
    });

    expect(result).toStrictEqual({ outcome: "not_capable" });
    expect(reviewer.requests()).toHaveLength(0);
    expect(factory.requests()).toHaveLength(0);
  });
});

const JOB_CREDENTIAL = `crj_${"C".repeat(43)}`;

/** A claim answer that hands out `reviewKind` whatever the claim asked for. */
function claimAnswering(jobId: string, reviewKind: "diff" | "dynamic") {
  return [
    {
      status: 200,
      body: {
        version: 1,
        job: {
          id: jobId,
          credential: JOB_CREDENTIAL,
          reviewKind,
          leaseExpiresAt: "2026-10-10T12:02:00.000Z",
          heartbeatIntervalSeconds: 30,
        },
      },
    },
  ];
}

/** Lets the core's waits (the retries of a release) pass until `done` settles. */
async function through<T>(done: Promise<T>): Promise<T> {
  let finished = false;
  void done.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  for (let step = 0; step < 100 && !finished; step += 1) {
    await clock.advance(1000);
    await settle();
  }
  return done;
}

describe("the second wall checks the engine too", () => {
  // #730-T21
  it("releases a claimed Dynamic job when this Dispatcher does not serve `opencode`, although the app may have Dynamic jobs, and creates no VM", async () => {
    const jobId = "00000000-0000-4000-8000-0000000000e1";
    factory.enqueue({ id: jobId, reviewKind: "diff" });
    // The app is asked for Diff engines only (opencode is not served here) and answers with a Dynamic job all the same.
    factory.script("claim", claimAnswering(jobId, "dynamic"));
    const { core, launcher, logger, recorded } = build({
      factory: { kinds: ["diff", "dynamic"] },
      launcher: { engines: ["pr-agent"] },
    });

    const result = await through(
      core.handle({ appId: "factory", jobId, reviewKind: "diff" }),
    );

    const claim = recorded.calls.find((call) => call.url.endsWith("/claim"));
    expect((claim?.body as { engines: string[] }).engines).toStrictEqual([
      "pr-agent",
    ]);
    expect(result).toStrictEqual({ outcome: "not_capable" });
    expect(launcher.launches).toHaveLength(0);
    expect(seen(factory, "release").length).toBeGreaterThan(0);
    expect(
      logger.lines.some((line) =>
        line.startsWith('error kind_not_allowed {"app":"factory"'),
      ),
    ).toBe(true);
    expect(logger.text()).toContain('"reason":"engine"');
    expect(logger.text()).not.toContain("crj_");
  });

  // #730-T21
  it("still launches a Diff job that comes back for the Diff engine of the same deployment", async () => {
    const jobId = "00000000-0000-4000-8000-0000000000e2";
    factory.enqueue({ id: jobId, reviewKind: "diff" });
    const { core, launcher } = build({ launcher: { engines: ["pr-agent"] } });

    const result = await handled(
      core.handle({ appId: "factory", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    expect(launcher.launches).toHaveLength(1);
  });
});

describe("the cap of an app is counted by the Dispatcher too", () => {
  const counts = (live: Record<string, number>): LiveVmCounter => {
    const counter = vi.fn(() => Promise.resolve(new Map(Object.entries(live))));
    return counter;
  };

  // #730-T22
  it("refuses a claim, without a call to the app, when the platform already shows the app's cap of live VMs", async () => {
    const jobId = factory.enqueue();
    const { core, launcher, logger } = build({
      factory: { maxRunning: 2 },
      // The cap is 2 and the Dispatcher tolerates 4 more (VMs outlive their jobs for a while): 6 VMs in all.
      liveVms: counts({ factory: 6 }),
    });

    const result = await core.handle({
      appId: "factory",
      jobId,
      reviewKind: "diff",
    });

    expect(result).toStrictEqual({ outcome: "busy", retryAfterSeconds: 30 });
    expect(factory.requests()).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
    expect(logger.text()).toContain(
      'app_cap_reached {"app":"factory","occupied":6,"maxRunning":2,"tolerance":4}',
    );
  });

  // #730-T22
  it("does not count the VMs of another app: a factory that fills its own cap leaves the reviewer all of its own", async () => {
    const reviewerJob = reviewer.enqueue();
    const { core } = build({
      reviewer: { maxRunning: 2 },
      liveVms: counts({ factory: 40, reviewer: 1 }),
    });

    const result = await handled(
      core.handle({
        appId: "reviewer",
        jobId: reviewerJob,
        reviewKind: "diff",
      }),
    );

    expect(result.outcome).toBe("started");
  });

  // #730-T22
  it("counts the untagged VMs of before the tenant tag as the reviewer's, and holds the reviewer to its cap", async () => {
    const jobId = reviewer.enqueue();
    const { core } = build({
      reviewer: { maxRunning: 3 },
      // `liveJobVmsByApp` puts an untagged VM under `reviewer`. The cap is 3, the tolerance 5.
      liveVms: counts({ reviewer: 8 }),
    });

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "diff",
    });

    expect(result).toStrictEqual({ outcome: "busy", retryAfterSeconds: 30 });
    expect(reviewer.requests()).toHaveLength(0);
  });

  // #730-T22
  it("starts a job up to the cap plus the tolerance and refuses the next one", async () => {
    const hold = deferred();
    const { core } = build({
      factory: { maxRunning: 2 },
      // Five live VMs: with the launch in progress that is the cap (2) plus the tolerance (4).
      liveVms: counts({ factory: 5 }),
      launcher: { onLaunch: () => hold.promise },
    });

    const first = await core.handle({
      appId: "factory",
      jobId: factory.enqueue(),
      reviewKind: "diff",
    });
    const second = await core.handle({
      appId: "factory",
      jobId: factory.enqueue(),
      reviewKind: "diff",
    });

    expect(first.outcome).toBe("started");
    expect(second).toStrictEqual({ outcome: "busy", retryAfterSeconds: 30 });
    hold.resolve();
    if (first.outcome === "started") await first.background;
  });

  // #730-T22
  it("counts a launch whose VM is already in the listing once, not twice", async () => {
    const hold = deferred();
    // The first launch has its VM; a listing taken after that shows it. The second call must see 5 VMs and 1 launch
    // without a VM yet (its own), not 5 VMs and 2 launches.
    const { core, launcher } = build({
      factory: { maxRunning: 2 },
      liveVms: counts({ factory: 5 }),
      launcher: {
        onLaunch: (spec) => {
          spec.onVmCreated?.({
            name: "cr-diff-x",
            startedAt: new Date(0),
            timeoutSeconds: 1500,
          });
          return hold.promise;
        },
      },
    });

    const first = await core.handle({
      appId: "factory",
      jobId: factory.enqueue(),
      reviewKind: "diff",
    });
    await clock.advance(6000);
    const second = await core.handle({
      appId: "factory",
      jobId: factory.enqueue(),
      reviewKind: "diff",
    });

    expect(first.outcome).toBe("started");
    expect(second.outcome).toBe("started");
    expect(launcher.launches).toHaveLength(2);
    hold.resolve();
    for (const result of [first, second])
      if (result.outcome === "started") await result.background;
  });

  // #730-T22
  it("counts the VMs of launches that are over but newer than the listing, so a cached listing cannot be outrun", async () => {
    // A launch creates its VM and ends: the VM lives on, and the listing (cached, taken before it) does not show it.
    const { core } = build({
      factory: { maxRunning: 2 },
      liveVms: counts({ factory: 5 }),
      launcher: {
        onLaunch: (spec) => {
          spec.onVmCreated?.({
            name: "cr-diff-x",
            startedAt: new Date(0),
            timeoutSeconds: 1500,
          });
          return Promise.resolve();
        },
      },
    });
    const next = () =>
      handled(
        core.handle({
          appId: "factory",
          jobId: factory.enqueue(),
          reviewKind: "diff",
        }),
      );

    expect((await next()).outcome).toBe("started");
    expect(await next()).toStrictEqual({
      outcome: "busy",
      retryAfterSeconds: 30,
    });

    // A new listing shows what is really there (five VMs), and the count starts from it. (The fake app has its own cap;
    // what matters is that the Dispatcher no longer refuses.)
    await clock.advance(6000);
    expect((await next()).outcome).not.toBe("busy");
  });

  // #730-T22
  it("tolerates the cap plus two: a VM outlives its job for a while, so VMs are not jobs", async () => {
    const outcomes: string[] = [];
    for (const [cap, live] of [
      [1, 3],
      [1, 4],
      [4, 9],
      [4, 10],
    ] as const) {
      reviewer.reset();
      const { core } = build({
        reviewer: { maxRunning: cap },
        liveVms: counts({ reviewer: live }),
      });
      const result = await handled(
        core.handle({
          appId: "reviewer",
          jobId: reviewer.enqueue(),
          reviewKind: "diff",
        }),
      );
      outcomes.push(result.outcome === "busy" ? "busy" : "passed");
    }

    // The VM the call would start included: cap 1 allows 4 VMs in all, cap 4 allows 10.
    expect(outcomes).toStrictEqual(["passed", "busy", "passed", "busy"]);
  });

  // #730-T22
  it("lists the platform once for the claims of a few seconds, and again after that", async () => {
    const counter = counts({});
    const { core } = build({ liveVms: counter });

    for (let call = 0; call < 3; call += 1)
      await handled(
        core.handle({
          appId: "factory",
          jobId: factory.enqueue(),
          reviewKind: "diff",
        }),
      );
    expect(counter).toHaveBeenCalledTimes(1);

    await clock.advance(6000);
    await handled(
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );
    expect(counter).toHaveBeenCalledTimes(2);
  });

  // #730-T22
  it("asks the platform once for claims that arrive together", async () => {
    const release = deferred();
    const counter = vi.fn(async () => {
      await release.promise;
      return new Map<string, number>();
    });
    const { core } = build({ liveVms: counter });

    const calls = [0, 1].map(() =>
      core.handle({
        appId: "reviewer",
        jobId: reviewer.enqueue(),
        reviewKind: "diff",
      }),
    );
    release.resolve();
    const results = await Promise.all(calls);

    expect(counter).toHaveBeenCalledTimes(1);
    for (const result of results)
      if (result.outcome === "started") await result.background;
  });

  // #730-T22
  it("turns a listing that hangs into a failure after four seconds and holds no slot while it waits", async () => {
    // A platform that never answers and ignores the signal: the wait itself must end.
    const hanging: LiveVmCounter = () => new Promise(() => undefined);
    const { core, logger } = build({
      factory: { maxRunning: 1 },
      liveVms: hanging,
    });

    const calls = [0, 1, 2].map(() =>
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );
    let answered = 0;
    for (const call of calls) void call.then(() => (answered += 1));
    await settle();
    await clock.advance(3999);
    // Three waiting calls at a cap of one: none of them took the slot, so none was answered `busy` and none is answered yet.
    expect(answered).toBe(0);

    await clock.advance(1);
    const results = await Promise.all(calls);

    // The listing failed, so the Dispatcher's own count decides (#802): one call takes the slot, the others find it taken.
    expect(results.map((result) => result.outcome).sort()).toStrictEqual([
      "busy",
      "busy",
      "started",
    ]);
    expect(logger.text()).toContain('fleet_list_failed {"ms":4000}');
    expect(factory.requests().filter((r) => r.route === "claim")).toHaveLength(
      1,
    );
    for (const result of results)
      if (result.outcome === "started") await result.background;
  });

  // #730-T22
  it("serves the next call normally after a listing that hung, with the slot free", async () => {
    let hang = true;
    const { core } = build({
      factory: { maxRunning: 1 },
      liveVms: () =>
        hang
          ? new Promise<never>(() => undefined)
          : Promise.resolve(new Map<string, number>()),
    });
    const firstJob = factory.enqueue();
    const first = core.handle({
      appId: "factory",
      jobId: firstJob,
      reviewKind: "diff",
    });
    await settle();
    await clock.advance(4000);
    expect((await handled(first)).outcome).toBe("started");
    // The App holds the cap of one itself: the first job ends, as it would, before the next is offered.
    factory.setJobStatus(firstJob, "succeeded");

    hang = false;
    // The failed listing is not asked again for five seconds (below), so this call is served by the Dispatcher's own count.
    await clock.advance(5000);
    const second = await handled(
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );

    expect(second.outcome).toBe("started");
  });

  // #730-T22
  it("hands the listing a signal that aborts after four seconds", async () => {
    let received: AbortSignal | undefined;
    const { core } = build({
      liveVms: (signal) => {
        received = signal;
        return new Promise<never>(() => undefined);
      },
    });
    const call = core.handle({
      appId: "factory",
      jobId: factory.enqueue(),
      reviewKind: "diff",
    });
    await settle();
    await clock.advance(3999);
    expect(received?.aborted).toBe(false);

    await clock.advance(1);

    expect(received?.aborted).toBe(true);
    await call;
  });

  // #730-T22
  it("does not let two calls that waited for the same listing both take the last slot", async () => {
    const release = deferred();
    const { core } = build({
      factory: { maxRunning: 1 },
      liveVms: async () => {
        await release.promise;
        return new Map<string, number>();
      },
      launcher: { onLaunch: () => release.promise },
    });
    const calls = [0, 1].map(() =>
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );
    release.resolve();
    const results = await Promise.all(calls);

    expect(results.map((result) => result.outcome).sort()).toStrictEqual([
      "busy",
      "started",
    ]);
    for (const result of results)
      if (result.outcome === "started") await result.background;
  });

  // #730-T22
  it("does not count a VM reported after its launch ended as one in flight", async () => {
    // The launch ends, then the Launcher reports its VM (a callback that arrives late). The VM is real, so it counts as
    // created; it must not make the next call think a launch without a VM has one more VM than it has.
    let late: ((vm: CreatedVm) => void) | undefined;
    const { core } = build({
      factory: { maxRunning: 1 },
      liveVms: counts({ factory: 3 }),
      launcher: {
        onLaunch: (spec) => {
          late = spec.onVmCreated;
          return Promise.resolve();
        },
      },
    });
    const first = await handled(
      core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );
    expect(first.outcome).toBe("started");
    late?.({
      name: "cr-diff-late",
      startedAt: new Date(0),
      timeoutSeconds: 1500,
    });

    // The cached listing shows 3; the late VM makes 4; with this call 5 is above the cap of 1 plus its tolerance of 3.
    const second = await core.handle({
      appId: "factory",
      jobId: factory.enqueue(),
      reviewKind: "diff",
    });

    expect(second).toStrictEqual({ outcome: "busy", retryAfterSeconds: 30 });
  });

  // #802-T02
  it("claims the job when the platform cannot be listed and no listing is young enough, and logs the failure without the platform's text", async () => {
    const jobId = factory.enqueue();
    const { core, logger } = build({
      liveVms: () => Promise.reject(new Error("the platform said something")),
    });

    const result = await handled(
      core.handle({ appId: "factory", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    expect(
      factory.requests().filter((request) => request.route === "claim"),
    ).toHaveLength(1);
    expect(logger.text()).toContain("fleet_list_failed");
    // The platform's own text is not ours to log.
    expect(logger.text()).not.toContain("the platform said something");
  });

  // #802-T02
  it("falls back to the Dispatcher's own count after a minute without a listing: the stale platform count is not used", async () => {
    let failing = false;
    const { core } = build({
      factory: { maxRunning: 1 },
      // The cap is 1 and the tolerance 3: a platform count of 4 refuses the call.
      liveVms: () =>
        failing
          ? Promise.reject(new Error("down"))
          : Promise.resolve(new Map([["factory", 4]])),
    });
    const handleOne = () =>
      handled(
        core.handle({
          appId: "factory",
          jobId: factory.enqueue(),
          reviewKind: "diff",
        }),
      );

    expect((await handleOne()).outcome).toBe("busy");
    failing = true;
    await clock.advance(10_000);
    // Inside the minute the last good listing still counts.
    expect((await handleOne()).outcome).toBe("busy");
    await clock.advance(61_000);
    // After it only what the Dispatcher knows counts, and that is nothing: the claim goes on.
    expect((await handleOne()).outcome).toBe("started");
  });

  // #802-T03
  it("does not ask a platform that just failed again for five seconds, and logs the failure once for those calls", async () => {
    const counter = vi.fn(() => Promise.reject(new Error("down")));
    const { core, logger } = build({ liveVms: counter });
    const handleOne = () =>
      handled(
        core.handle({
          appId: "factory",
          jobId: factory.enqueue(),
          reviewKind: "diff",
        }),
      );

    await handleOne();
    await handleOne();
    await handleOne();

    expect(counter).toHaveBeenCalledTimes(1);
    expect(logger.text().match(/fleet_list_failed/g)).toHaveLength(1);

    await clock.advance(5000);
    await handleOne();

    expect(counter).toHaveBeenCalledTimes(2);
    expect(logger.text().match(/fleet_list_failed/g)).toHaveLength(2);
  });

  describe("without a listing, the Dispatcher counts the VMs its own launches created", () => {
    const vm = (name: string): CreatedVm => ({
      name,
      startedAt: new Date(0),
      timeoutSeconds: 1500,
    });
    const failing: LiveVmCounter = () => Promise.reject(new Error("down"));

    /** A Launcher whose launches end at once but leave a VM behind, as a Worker that runs on. */
    function leaving() {
      let created = 0;
      return {
        onLaunch: (spec: { onVmCreated?: (vm: CreatedVm) => void }) => {
          created += 1;
          spec.onVmCreated?.(vm(`cr-diff-created-${created}`));
          return Promise.resolve();
        },
      };
    }

    /** One call for the app, whose job then ends at the App, so the App's own cap never gets in the way of the count. */
    async function claim(core: ReturnType<typeof build>["core"], app: string) {
      const queue = app === "factory" ? factory : reviewer;
      const jobId = queue.enqueue();
      const result = await core.handle({
        appId: app,
        jobId,
        reviewKind: "diff",
      });
      if (result.outcome === "started") await result.background;
      queue.setJobStatus(jobId, "succeeded");
      return result;
    }

    // #802-T04
    it("holds an app that is over its cap: the VMs it created count, plus the one this call would start", async () => {
      const { core, logger } = build({
        factory: { maxRunning: 1 },
        liveVms: failing,
        launcher: leaving(),
      });
      // The cap is 1 and the tolerance 3: four VMs in all are allowed, the fifth call is refused.
      for (let call = 0; call < 4; call += 1) {
        const result = await claim(core, "factory");
        expect(result.outcome).toBe("started");
      }

      const refused = await claim(core, "factory");

      expect(refused).toStrictEqual({ outcome: "busy", retryAfterSeconds: 30 });
      expect(logger.text()).toContain(
        'app_cap_reached {"app":"factory","occupied":4,"maxRunning":1,"tolerance":3}',
      );
      expect(
        factory.requests().filter((request) => request.route === "claim"),
      ).toHaveLength(4);
    });

    // #802-T04
    it("keeps claiming for an app below its cap while another app is over its own", async () => {
      const { core } = build({
        factory: { maxRunning: 1 },
        reviewer: { maxRunning: 5 },
        liveVms: failing,
        launcher: leaving(),
      });
      for (let call = 0; call < 4; call += 1) await claim(core, "factory");

      const forFactory = await claim(core, "factory");
      const forReviewer = await claim(core, "reviewer");

      expect(forFactory.outcome).toBe("busy");
      expect(forReviewer.outcome).toBe("started");
    });

    // #802-T07
    it("counts the launches in progress that have no VM yet", async () => {
      // Cap 3, tolerance 5: eight VMs and the one a call would start are allowed. Six VMs created lately and two launches
      // that have no VM yet make eight: the next call would be the ninth and is refused. With the launches not counted
      // it would see six and pass.
      const hold = deferred();
      let launches = 0;
      const { core } = build({
        factory: { maxRunning: 3 },
        liveVms: failing,
        launcher: {
          onLaunch: (spec) => {
            launches += 1;
            if (launches <= 6) {
              spec.onVmCreated?.(vm(`cr-diff-created-${launches}`));
              return Promise.resolve();
            }
            // Launches without a VM: the Launcher is still making it.
            return hold.promise;
          },
        },
      });
      for (let call = 0; call < 6; call += 1) await claim(core, "factory");
      const waiting = [0, 1].map(() => {
        const jobId = factory.enqueue();
        return core.handle({ appId: "factory", jobId, reviewKind: "diff" });
      });
      await settle();

      const ninth = factory.enqueue();
      const results = await Promise.all(waiting);
      expect(results.map((result) => result.outcome)).toStrictEqual([
        "started",
        "started",
      ]);
      const refused = await core.handle({
        appId: "factory",
        jobId: ninth,
        reviewKind: "diff",
      });
      expect(refused.outcome).toBe("busy");

      hold.resolve();
      for (const result of results)
        if (result.outcome === "started") await result.background;
    });

    // #802-T05
    it("forgets a VM after ten minutes: a long outage must not turn the soft limit into a stop", async () => {
      const { core } = build({
        factory: { maxRunning: 1 },
        liveVms: failing,
        launcher: leaving(),
      });
      for (let call = 0; call < 4; call += 1) await claim(core, "factory");
      expect((await claim(core, "factory")).outcome).toBe("busy");

      await clock.advance(10 * 60 * 1000);

      expect((await claim(core, "factory")).outcome).toBe("started");
    });
  });

  // #730-T22
  it("keeps today's behaviour without a fleet: the cap is the launches in progress", async () => {
    const jobId = reviewer.enqueue();
    const { core } = build({ reviewer: { maxRunning: 1 } });

    const result = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
  });
});

// #759: the kind `implementer` is the factory's alone; the reviewer's entry cannot get it, whatever the engines say.
describe("the core with the implementer kind", () => {
  const ENGINES = ["pr-agent", "opencode", "implementer"] as const;

  function buildImplementing(
    options: {
      factoryKinds?: AppSettings["kinds"];
      core?: Partial<CoreSettings>;
      launcherEngines?: Parameters<typeof createFakeLauncher>[0];
    } = {},
  ) {
    const logger = recordingLogger();
    const launcher = createFakeLauncher(
      options.launcherEngines ?? { engines: ENGINES },
    );
    const recorded = recordingFetch();
    const core = createDispatcherCore({
      settings: settingsFor(reviewer.url, {
        engines: ENGINES,
        ...options.core,
        more: [
          factoryApp({
            kinds: options.factoryKinds ?? ["diff", "dynamic", "implementer"],
          }),
        ],
      }),
      launcher,
      clock,
      logger,
      fetch: recorded.fetch,
      now: () => clock.now(),
    });
    return { core, launcher, logger, recorded };
  }

  const claimsOf = (recorded: ReturnType<typeof recordingFetch>) =>
    recorded.calls.filter((call) => call.url.endsWith("/claim"));

  // #759-T04
  it("claims a job of the implementer kind at the factory, and at the factory only, and starts it with the kind", async () => {
    const jobId = factory.enqueue({ reviewKind: "implementer" });
    const { core, launcher, recorded } = buildImplementing();

    const result = await handled(
      core.handle({ appId: "factory", jobId, reviewKind: "implementer" }),
    );

    expect(result.outcome).toBe("started");
    const claims = claimsOf(recorded);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.url.startsWith(factory.url)).toBe(true);
    expect(reviewer.requests()).toHaveLength(0);
    expect(launcher.launches.map((spec) => [spec.appId, spec.kind])).toEqual([
      ["factory", "implementer"],
    ]);
  });

  // #759-T04
  it("answers `not_capable` for the implementer kind named by the reviewer, with no claim and no launch, although the engine is served", async () => {
    const jobId = reviewer.enqueue();
    const { core, launcher, recorded, logger } = buildImplementing();

    const result = await core.handle({
      appId: "reviewer",
      jobId,
      reviewKind: "implementer",
    });

    expect(result).toStrictEqual({ outcome: "not_capable" });
    expect(claimsOf(recorded)).toHaveLength(0);
    expect(reviewer.requests()).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
    expect(
      logger.lines.some((line) => line.startsWith("warn kind_not_allowed")),
    ).toBe(true);
  });

  // #759-T05
  it("asks for the implementer engine in the factory's claim only because the factory's kinds name it", async () => {
    const withKind = buildImplementing();
    await handled(
      withKind.core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );
    const withoutKind = buildImplementing({
      factoryKinds: ["diff", "dynamic"],
    });
    await handled(
      withoutKind.core.handle({
        appId: "factory",
        jobId: factory.enqueue(),
        reviewKind: "diff",
      }),
    );

    expect(claimsOf(withKind.recorded)[0]?.body).toMatchObject({
      engines: ["pr-agent", "opencode", "implementer"],
    });
    expect(claimsOf(withoutKind.recorded)[0]?.body).toMatchObject({
      engines: ["pr-agent", "opencode"],
    });
  });

  // #759-T05
  it("keeps the reviewer's claim engines as they are, although the deployment serves the implementer engine", async () => {
    const { core, recorded } = buildImplementing();

    await handled(
      core.handle({
        appId: "reviewer",
        jobId: reviewer.enqueue(),
        reviewKind: "diff",
      }),
    );

    expect(claimsOf(recorded)[0]?.body).toMatchObject({
      engines: ["pr-agent", "opencode"],
    });
  });

  // #759-T05
  it("does not hand an implementer job to a claim that did not ask for the engine", async () => {
    const jobId = factory.enqueue({ reviewKind: "implementer" });
    const { core, launcher } = buildImplementing({
      factoryKinds: ["diff", "dynamic"],
    });

    const result = await core.handle({
      appId: "factory",
      jobId,
      reviewKind: "diff",
    });

    expect(result).toStrictEqual({ outcome: "ignored" });
    expect(launcher.launches).toHaveLength(0);
  });

  // #759-T06
  it("releases a claimed implementer job of the reviewer app unlaunched, logs `kind_not_allowed` at error level and makes no VM", async () => {
    const jobId = "00000000-0000-4000-8000-0000000000f1";
    reviewer.enqueue({ id: jobId });
    reviewer.script("claim", [
      {
        status: 200,
        body: {
          version: 1,
          job: {
            id: jobId,
            credential: `crj_${"A".repeat(43)}`,
            reviewKind: "implementer",
            leaseExpiresAt: "2026-10-10T12:02:00.000Z",
            heartbeatIntervalSeconds: 30,
          },
        },
      },
    ]);
    const { core, launcher, logger } = buildImplementing();

    const done = core.handle({ appId: "reviewer", jobId, reviewKind: "diff" });
    let result: HandleResult | undefined;
    void done.then((answer) => {
      result = answer;
    });
    for (let step = 0; step < 100 && result === undefined; step += 1) {
      await clock.advance(1000);
      await settle();
    }

    expect(await done).toStrictEqual({ outcome: "not_capable" });
    expect(launcher.launches).toHaveLength(0);
    expect(seen(reviewer, "release").length).toBeGreaterThan(0);
    expect(
      logger.lines.some((line) => line.startsWith("error kind_not_allowed")),
    ).toBe(true);
    expect(logger.text()).not.toContain("crj_");
  });

  // #759-T07
  it.each([
    ["3600 seconds by default", undefined, 3600],
    ["the configured value when there is one", 7200, 7200],
  ])(
    "starts an implementer launch with %s, and Diff and Dynamic with the job timeout",
    async (_name, configured, implementer) => {
      const { core, launcher } = buildImplementing({
        core:
          configured === undefined
            ? {}
            : { implementerTimeoutSeconds: configured },
      });
      for (const [app, reviewKind] of [
        ["factory", "implementer"],
        ["factory", "dynamic"],
        ["reviewer", "diff"],
      ] as const)
        await handled(
          core.handle({
            appId: app,
            jobId: (app === "factory" ? factory : reviewer).enqueue({
              reviewKind,
            }),
            reviewKind,
          }),
        );

      expect(
        launcher.launches.map((spec) => [spec.kind, spec.timeoutSeconds]),
      ).toEqual([
        ["implementer", implementer],
        ["dynamic", 1200],
        ["diff", 1200],
      ]);
    },
  );

  // #759-T08
  it("passes the implementer's launch configuration to the launcher, and nothing of another kind's", async () => {
    const config = { launcher: { vcpus: 2 } };
    const { core, launcher } = buildImplementing({
      core: { workerConfig: { diff: {}, dynamic: {}, implementer: config } },
    });

    await handled(
      core.handle({
        appId: "factory",
        jobId: factory.enqueue({ reviewKind: "implementer" }),
        reviewKind: "implementer",
      }),
    );

    expect(launcher.launches[0]?.config).toStrictEqual(config);
  });
});
