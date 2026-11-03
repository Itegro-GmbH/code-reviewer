// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import { ConfigError } from "../config.ts";
import { noLauncher } from "./none.ts";
import { sandboxFromEnvironment } from "./sandbox-env.ts";
import { IMPLEMENTER_PROBE_EXTRA_SECONDS } from "./sandbox-canary.ts";
import {
  LAUNCH_STEPS_SECONDS,
  SANDBOX_HANDOVER_SECONDS,
  IMPLEMENTER_LAUNCH_EXTRA_SECONDS,
  WORK_VOLUME_STEPS_SECONDS,
} from "./sandbox.ts";
import { recordingLogger } from "../test-support/harness.ts";
import { GoldenRecordSchema } from "../snapshot/record.ts";
import { loadSettings } from "../config.ts";
import type { SandboxSdk } from "./vercel-sandbox.ts";

const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const PLATFORM_TOKEN = "dummy-platform-token-for-tests-0000";
const BASE = {
  RUNNER_API_URL: "http://127.0.0.1:9",
  RUNNER_TOKEN: "dummy-dispatcher-token-for-tests",
  DISPATCHER_MAX_RUNNING: "2",
  DISPATCHER_SIGNING_KEY_ID: "k1",
  DISPATCHER_SIGNING_SECRET: "dummy-signing-secret-current-0000000000",
};

function configured(extra: Record<string, string> = {}) {
  return {
    SANDBOX_SNAPSHOT_ID: "snap_dummy_golden_0001",
    SANDBOX_IMAGE_DIGEST: IMAGE_DIGEST,
    ...extra,
  };
}

function refusal(env: Record<string, string>): ConfigError {
  try {
    sandboxFromEnvironment(env, () => Promise.reject(new Error("not loaded")));
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("the configuration was expected to be refused");
}

const never: () => Promise<SandboxSdk> = () =>
  Promise.reject(new Error("not loaded"));

describe("the Sandbox-Launcher's configuration from the environment", () => {
  // #329 (additional): not configured is fail closed, not an error
  it("is the launcher that advertises nothing when no snapshot is configured", async () => {
    const sandbox = sandboxFromEnvironment({}, never);
    const settings = loadSettings(BASE);

    const launcher = sandbox.launcher({
      settings,
      logger: recordingLogger(),
      background: () => undefined,
    });

    expect(launcher).toBe(noLauncher);
    expect(sandbox.secrets).toStrictEqual([]);
  });

  // #329 (additional)
  it("builds the Sandbox-Launcher, which advertises the two reviewer engines, when the snapshot and the image are configured", async () => {
    const sandbox = sandboxFromEnvironment(configured(), never);

    const launcher = sandbox.launcher({
      settings: loadSettings(BASE),
      logger: recordingLogger(),
      background: () => undefined,
    });

    expect(launcher).not.toBe(noLauncher);
    expect(
      await launcher.capabilities(new AbortController().signal),
    ).toStrictEqual(["pr-agent", "opencode"]);
  });

  // #745 step 4: the verdict of the snapshot's record is optional and read only by the Implementer
  it.each(["proven", "unproven", undefined])(
    "accepts the snapshot's Sysbox verdict %s",
    (verdict) => {
      const sandbox = sandboxFromEnvironment(
        configured(
          verdict === undefined ? {} : { SANDBOX_SYSBOX_PROOF: verdict },
        ),
        never,
      );
      expect(
        sandbox.launcher({
          settings: loadSettings(BASE),
          logger: recordingLogger(),
          background: () => undefined,
        }),
      ).not.toBe(noLauncher);
    },
  );

  // #745-T02: reviews never read the verdict, so whatever it holds, the Dispatcher starts; the Implementer's gate then
  // sees `unproven` for everything but exactly `proven`
  it.each(["probably", "Proven", "proven ", "unrecorded", ""])(
    "starts with the Sysbox verdict %j and does not take it for proven",
    (verdict) => {
      const sandbox = sandboxFromEnvironment(
        configured({ SANDBOX_SYSBOX_PROOF: verdict }),
        never,
      );
      expect(
        sandbox.launcher({
          settings: loadSettings(BASE),
          logger: recordingLogger(),
          background: () => undefined,
        }),
      ).not.toBe(noLauncher);
    },
  );

  // #329 (additional): the record of the golden snapshot pipeline (#330) is what these variables hold
  it("accepts the snapshot id and the image id of a golden snapshot record as they are", () => {
    const record = GoldenRecordSchema.parse({
      version: 1,
      snapshotId: "snap_dummy_golden_0001",
      imageDigest: IMAGE_DIGEST,
      builtAt: "2026-10-15T12:00:00.000Z",
      region: "fra1",
      target: "sandbox",
    });

    const sandbox = sandboxFromEnvironment(
      {
        SANDBOX_SNAPSHOT_ID: record.snapshotId,
        SANDBOX_IMAGE_DIGEST: record.imageDigest,
      },
      never,
    );

    expect(
      sandbox.launcher({
        settings: loadSettings(BASE),
        logger: recordingLogger(),
        background: () => undefined,
      }),
    ).not.toBe(noLauncher);
  });

  // #329 (additional)
  it.each<[string, Record<string, string>, string]>([
    [
      "an image id without a snapshot",
      { SANDBOX_IMAGE_DIGEST: IMAGE_DIGEST },
      "SANDBOX_SNAPSHOT_ID",
    ],
    [
      "a snapshot without an image id",
      { SANDBOX_SNAPSHOT_ID: "snap_dummy_golden_0001" },
      "SANDBOX_IMAGE_DIGEST",
    ],
    [
      "a snapshot id with a space",
      configured({ SANDBOX_SNAPSHOT_ID: "snap x" }),
      "SANDBOX_SNAPSHOT_ID",
    ],
    [
      "an image id that is not a sha256 digest",
      configured({ SANDBOX_IMAGE_DIGEST: "latest" }),
      "SANDBOX_IMAGE_DIGEST",
    ],
    [
      "an image id of the wrong length",
      configured({ SANDBOX_IMAGE_DIGEST: "sha256:abc" }),
      "SANDBOX_IMAGE_DIGEST",
    ],
    [
      "a hand-over time of zero",
      configured({ SANDBOX_HANDOVER_SECONDS: "0" }),
      "SANDBOX_HANDOVER_SECONDS",
    ],
    [
      "a hand-over time that is not a number",
      configured({ SANDBOX_HANDOVER_SECONDS: "soon" }),
      "SANDBOX_HANDOVER_SECONDS",
    ],
    [
      "a token without a team",
      configured({
        VERCEL_TOKEN: PLATFORM_TOKEN,
        VERCEL_PROJECT_ID: "prj_dummy",
      }),
      "VERCEL_TEAM_ID",
    ],
    [
      "a token without a project",
      configured({
        VERCEL_TOKEN: PLATFORM_TOKEN,
        VERCEL_TEAM_ID: "team_dummy",
      }),
      "VERCEL_PROJECT_ID",
    ],
  ])("refuses %s and names the variable", (_what, env, variable) => {
    const error = refusal(env);

    expect(error.variable).toBe(variable);
    expect(error.message).not.toContain(PLATFORM_TOKEN);
    expect(error.message).not.toContain(IMAGE_DIGEST);
  });

  // #329 (additional): the platform token is a secret of this deployment
  it("reports the platform token as a secret so the logger masks it", () => {
    const sandbox = sandboxFromEnvironment(
      configured({
        VERCEL_TOKEN: PLATFORM_TOKEN,
        VERCEL_TEAM_ID: "team_dummy",
        VERCEL_PROJECT_ID: "prj_dummy",
        VERCEL_OIDC_TOKEN: "dummy-oidc-token-for-tests-0000",
      }),
      never,
    );

    expect(sandbox.secrets).toStrictEqual([
      PLATFORM_TOKEN,
      "dummy-oidc-token-for-tests-0000",
    ]);
  });

  // #329-R05
  it.each<[string, Record<string, string>, string]>([
    [
      "a margin below the floor",
      configured({ SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "179" }),
      "SANDBOX_VM_TIMEOUT_MARGIN_SECONDS",
    ],
    [
      "a margin that is not a number",
      configured({ SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "long" }),
      "SANDBOX_VM_TIMEOUT_MARGIN_SECONDS",
    ],
    [
      "a margin above an hour",
      configured({ SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "3601" }),
      "SANDBOX_VM_TIMEOUT_MARGIN_SECONDS",
    ],
    [
      "a margin that does not cover the hand-over time",
      configured({
        SANDBOX_HANDOVER_SECONDS: "100",
        SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "249",
      }),
      "SANDBOX_VM_TIMEOUT_MARGIN_SECONDS",
    ],
  ])("refuses %s and names the variable", (_what, env, variable) => {
    expect(refusal(env).variable).toBe(variable);
  });

  // #329-R05
  it("accepts the margin at its floor and in the middle", () => {
    for (const margin of ["180", "300", "3600"])
      expect(() =>
        sandboxFromEnvironment(
          configured({ SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: margin }),
          never,
        ),
      ).not.toThrow();
  });

  // #329-R06
  it("refuses a hand-over time that, with create, prepare and the image check, would pass the core's launch deadline", () => {
    const sandbox = sandboxFromEnvironment(
      configured({ SANDBOX_HANDOVER_SECONDS: "120" }),
      never,
    );
    const make = (launchDeadlineSeconds: number) => {
      const settings = loadSettings(BASE);
      return sandbox.launcher({
        settings: {
          ...settings,
          core: { ...settings.core, launchDeadlineSeconds },
        },
        logger: recordingLogger(),
        background: () => undefined,
      });
    };

    expect(() => make(300)).not.toThrow();
    expect(() => make(270)).not.toThrow();
    expect(() => make(269)).toThrowError(/SANDBOX_HANDOVER_SECONDS/);
  });

  // #329-T11
  it("refuses a worker configuration the Launcher cannot run at start, not at the first job", () => {
    const sandbox = sandboxFromEnvironment(configured(), never);
    const settings = loadSettings({
      ...BASE,
      DISPATCHER_WORKER_CONFIG: JSON.stringify({
        dynamic: { launcher: { vcpus: 3 } },
      }),
    });

    expect(() =>
      sandbox.launcher({
        settings,
        logger: recordingLogger(),
        background: () => undefined,
      }),
    ).toThrowError(/DISPATCHER_WORKER_CONFIG/);
  });

  // #329-T11
  it("accepts a worker configuration with its own size and memory per kind", () => {
    const sandbox = sandboxFromEnvironment(configured(), never);
    const settings = loadSettings({
      ...BASE,
      DISPATCHER_WORKER_CONFIG: JSON.stringify({
        dynamic: {
          launcher: { vcpus: 2 },
          container: { memory: { limit: "3g", reservation: "2g" } },
        },
        diff: { launcher: { vcpus: 1 } },
      }),
    });

    expect(() =>
      sandbox.launcher({
        settings,
        logger: recordingLogger(),
        background: () => undefined,
      }),
    ).not.toThrow();
  });

  // #760-T04
  describe("an implementer configuration in DISPATCHER_WORKER_CONFIG", () => {
    const registry = {
      DISPATCHER_APPS: JSON.stringify([
        {
          id: "factory",
          url: "https://factory.example.test",
          kinds: ["implementer"],
          keyId: "factory-k1",
          maxRunning: 1,
        },
      ]),
      DISPATCHER_APP_FACTORY_TOKEN: "factory-dispatcher-token-for-tests-0001",
      DISPATCHER_APP_FACTORY_SIGNING_SECRET:
        "factory-signing-secret-for-tests-000001",
      DISPATCHER_OPERATOR_TOKEN: "operator-token-for-the-tests-0000000001",
    };
    /** A platform that is never reached for good: it counts the loads, and a load that happens is a launch that got past its configuration. */
    function counting() {
      const loads = { count: 0 };
      const load: () => Promise<SandboxSdk> = () => {
        loads.count += 1;
        return Promise.reject(new Error("not loaded"));
      };
      return { loads, load };
    }
    function launcherWith(
      worker: Record<string, unknown>,
      options: { served?: boolean; load?: () => Promise<SandboxSdk> } = {},
    ) {
      const logger = recordingLogger();
      const launcher = sandboxFromEnvironment(
        configured(),
        options.load ?? never,
      ).launcher({
        settings: loadSettings({
          ...BASE,
          ...(options.served === false ? {} : registry),
          DISPATCHER_WORKER_CONFIG: JSON.stringify(worker),
        }),
        logger,
        background: () => undefined,
      });
      return { launcher, logger };
    }
    const launchSpec = (
      kind: "diff" | "dynamic" | "implementer",
      config: Record<string, unknown> = {},
    ) => ({
      appId: kind === "implementer" ? "factory" : "reviewer",
      appUrl: "https://app.example.invalid",
      jobId: "00000000-0000-4000-8000-000000000001",
      credential: "crj_dummy-credential-0123456789-abcdefghijklmnopq",
      kind,
      timeoutSeconds: 1200,
      config,
    });

    // A value only the Implementer reads cannot stop the Dispatcher from starting (it would fail the canary of every
    // release it deploys): it is logged, each launch of the kind is refused, and the canary of a deployment that serves the
    // kind reports `implementer_probe_failed` (see the canary tests).
    it.each([
      [
        "a container memory the VM cannot give",
        { container: { memory: { limit: "8g" } } },
      ],
      ["a VM size the platform does not have", { launcher: { vcpus: 3 } }],
    ])(
      "does not stop the Dispatcher from starting for %s: it logs an error",
      (_what, implementer) => {
        const { launcher, logger } = launcherWith({ implementer });

        expect(launcher).toBeDefined();
        expect(
          logger.lines.filter((line) =>
            line.startsWith("error worker_config_invalid "),
          ),
        ).toHaveLength(1);
        expect(logger.text()).toContain('"kind":"implementer"');
      },
    );

    it("leaves Diff and Dynamic working while an implementer launch is refused before it reaches the platform", async () => {
      const implementer = { container: { memory: { limit: "8g" } } };
      const signal = new AbortController().signal;
      // The SDK is loaded once per launcher, by the first call that reaches the platform: one launcher per kind.
      const reached = async (kind: "diff" | "dynamic" | "implementer") => {
        const { loads, load } = counting();
        const { launcher } = launcherWith({ implementer }, { load });
        const error = await launcher
          .launch(
            launchSpec(kind, kind === "implementer" ? implementer : {}),
            signal,
          )
          .catch((thrown: unknown) => thrown);
        return { loads: loads.count, code: (error as { code?: string }).code };
      };

      expect(await reached("implementer")).toStrictEqual({
        loads: 0,
        code: "sandbox_config_invalid",
      });
      // Diff and Dynamic are not touched by the bad value: their launches get as far as the platform.
      expect((await reached("diff")).loads).toBe(1);
      expect((await reached("dynamic")).loads).toBe(1);
    });

    it("still refuses a bad Diff or Dynamic value at start, and accepts a sized implementer", () => {
      expect(() =>
        launcherWith({ dynamic: { launcher: { vcpus: 3 } }, implementer: {} }),
      ).toThrowError(/DISPATCHER_WORKER_CONFIG/);
      const sized = launcherWith({
        implementer: {
          launcher: { vcpus: 4 },
          container: { memory: { limit: "6g", reservation: "5g" } },
          timeoutSeconds: 7200,
        },
      });
      expect(sized.logger.lines).toStrictEqual([]);
      expect(launcherWith({ implementer: {} }).logger.lines).toStrictEqual([]);
    });

    it("does not read the entry of a deployment that serves no implementer job", () => {
      const { logger } = launcherWith(
        { implementer: { container: { memory: { limit: "8g" } } } },
        { served: false },
      );

      expect(logger.lines).toStrictEqual([]);
    });
  });

  // #760-T10
  it("fits the steps of an implementer launch in the launch deadline of the core, with the Worker's hand-over and a margin of 5 seconds", () => {
    const steps =
      SANDBOX_HANDOVER_SECONDS +
      LAUNCH_STEPS_SECONDS +
      IMPLEMENTER_LAUNCH_EXTRA_SECONDS;
    // 20 + 150 + 124 = 294 of 300: the run-directory steps (3 x 3 s) and the IPv6 step (3 s) have their 3 s because the eight
    // steps of the work volume have 9 s each. A step that grows must take its seconds from another ceiling.
    expect(steps).toBeLessThanOrEqual(
      loadSettings(BASE).core.launchDeadlineSeconds - 5,
    );
  });

  // #765-D1, D2: the probe that `POST /probe` runs is built from the environment of the deployment.
  describe("the canary of the deployment", () => {
    const FACTORY = {
      DISPATCHER_APPS: JSON.stringify([
        {
          id: "factory",
          url: "https://factory.example.test",
          kinds: ["diff", "dynamic", "implementer"],
          keyId: "factory-k1",
          maxRunning: 1,
        },
      ]),
      DISPATCHER_APP_FACTORY_TOKEN: "factory-dispatcher-token-for-tests-0001",
      DISPATCHER_APP_FACTORY_SIGNING_SECRET:
        "factory-signing-secret-for-tests-000001",
      DISPATCHER_OPERATOR_TOKEN: "operator-token-for-the-tests-0000000001",
    };
    const PASSING = `${JSON.stringify({ version: 1, engines: ["pr-agent", "opencode"], reasons: [] })}\n`;
    const WITH_IMPLEMENTER = `${JSON.stringify({ version: 1, engines: ["pr-agent", "opencode", "implementer"], reasons: [] })}\n`;

    async function probed(extra: Record<string, string>) {
      const service = new FakeSandboxService();
      service.onExec("image-id", { stdout: `${IMAGE_DIGEST}\n` });
      service.onExec("probe", { stdout: PASSING });
      service.onExec("probe-implementer", { stdout: WITH_IMPLEMENTER });
      const sandbox = sandboxFromEnvironment(configured(), never, service);
      const settings = loadSettings({ ...BASE, ...extra });
      const launcher = sandbox.launcher({
        settings,
        logger: recordingLogger(),
        background: () => undefined,
      });
      const result = await launcher.probe?.(new AbortController().signal);
      return { service, result, sandbox, settings };
    }

    it("runs the Implementer's probe, in a VM that holds its container, when the deployment serves the kind", async () => {
      const { service, result } = await probed(FACTORY);

      expect(service.execs.map((call) => call.label)).toContain(
        "probe-implementer",
      );
      expect(service.creates).toHaveLength(1);
      expect(service.creates[0]?.vcpus).toBe(2);
      expect(result).toMatchObject({
        status: "passed",
        engines: ["pr-agent", "opencode", "implementer"],
      });
    });

    it("runs exactly the probe it always did when the deployment does not serve the kind", async () => {
      const { service, result } = await probed({});

      expect(service.execs.map((call) => call.label)).not.toContain(
        "probe-implementer",
      );
      expect(
        service.execs.filter((call) => call.label.startsWith("work-volume")),
      ).toStrictEqual([]);
      expect(service.creates[0]?.vcpus).toBe(1);
      expect(result).toMatchObject({
        engines: ["pr-agent", "opencode"],
      });
    });

    it("gives the probe of a deployment with the kind the volume steps and the second probe on top of its time, and the reaper the same", async () => {
      const served = await probed(FACTORY);
      const plain = await probed({});

      const lifetime = (run: Awaited<ReturnType<typeof probed>>) =>
        (run.service.creates[0]?.timeoutMs ?? 0) / 1000;
      expect(lifetime(served) - lifetime(plain)).toBe(
        IMPLEMENTER_PROBE_EXTRA_SECONDS,
      );
      expect(IMPLEMENTER_PROBE_EXTRA_SECONDS).toBe(
        WORK_VOLUME_STEPS_SECONDS + 60,
      );
      // The reaper must not end a canary VM that is still within its life.
      const reaper = (run: Awaited<ReturnType<typeof probed>>) =>
        run.sandbox.reaper?.(run.settings)?.canaryLifetimeSeconds ?? 0;
      expect(reaper(served) - reaper(plain)).toBe(
        IMPLEMENTER_PROBE_EXTRA_SECONDS,
      );
      // Well inside what one function call may last.
      expect(reaper(served)).toBeLessThan(1800);
    });
  });

  // #364-T18
  it("has no reaper when no snapshot is configured, so there is no route and no platform call", () => {
    expect(sandboxFromEnvironment({}, never).reaper).toBeUndefined();
  });

  // #364-T14
  it("sets the reaper's lifetimes from the job timeout, the probe timeout and the VM margin, with the platform's access", () => {
    const sandbox = sandboxFromEnvironment(configured(), never);

    const reaper = sandbox.reaper?.(loadSettings(BASE));

    expect(reaper).toMatchObject({
      jobLifetimeSeconds: 1200 + 300,
      canaryLifetimeSeconds: 150 + 300,
    });
    expect(typeof reaper?.fleet.list).toBe("function");
    expect(typeof reaper?.fleet.stop).toBe("function");
  });

  // #364-T14
  it("follows the configured job timeout, probe timeout and margin", () => {
    const sandbox = sandboxFromEnvironment(
      configured({
        SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "600",
        DISPATCHER_PROBE_TIMEOUT_SECONDS: "300",
      }),
      never,
    );

    const reaper = sandbox.reaper?.(
      loadSettings({ ...BASE, DISPATCHER_JOB_TIMEOUT_SECONDS: "3600" }),
    );

    expect(reaper).toMatchObject({
      jobLifetimeSeconds: 3600 + 600,
      canaryLifetimeSeconds: 300 + 600,
    });
  });

  // #759 (additional)
  it("lets the reaper wait for the longest job a served kind can have: the implementer's 3600 seconds only when an app has the kind", () => {
    const sandbox = sandboxFromEnvironment(configured(), never);
    const registry = {
      DISPATCHER_APPS: JSON.stringify([
        {
          id: "factory",
          url: "https://factory.example.test",
          kinds: ["diff", "implementer"],
          keyId: "factory-k1",
          maxRunning: 1,
        },
      ]),
      DISPATCHER_APP_FACTORY_TOKEN: "factory-dispatcher-token-for-tests-0001",
      DISPATCHER_APP_FACTORY_SIGNING_SECRET:
        "factory-signing-secret-for-tests-000001",
      DISPATCHER_OPERATOR_TOKEN: "operator-token-for-the-tests-0000000001",
    };

    expect(
      sandbox.reaper?.(loadSettings({ ...BASE, ...registry }))
        ?.jobLifetimeSeconds,
    ).toBe(3600 + 300);
    expect(
      sandbox.reaper?.(
        loadSettings({
          ...BASE,
          ...registry,
          DISPATCHER_WORKER_CONFIG: JSON.stringify({
            implementer: { timeoutSeconds: 7200 },
          }),
        }),
      )?.jobLifetimeSeconds,
    ).toBe(7200 + 300);
    // Nothing changes for a deployment that serves no implementer job, configured timeout or not.
    expect(
      sandbox.reaper?.(
        loadSettings({
          ...BASE,
          DISPATCHER_WORKER_CONFIG: JSON.stringify({
            implementer: { timeoutSeconds: 7200 },
          }),
        }),
      )?.jobLifetimeSeconds,
    ).toBe(1200 + 300);
  });

  // #765
  describe("the engines the Launcher advertises", () => {
    const FACTORY = {
      DISPATCHER_APPS: JSON.stringify([
        {
          id: "factory",
          url: "https://factory.example.test",
          kinds: ["diff", "dynamic", "implementer"],
          keyId: "factory-k1",
          maxRunning: 1,
        },
      ]),
      DISPATCHER_APP_FACTORY_TOKEN: "factory-dispatcher-token-for-tests-0001",
      DISPATCHER_APP_FACTORY_SIGNING_SECRET:
        "factory-signing-secret-for-tests-000001",
      DISPATCHER_OPERATOR_TOKEN: "operator-token-for-the-tests-0000000001",
    };
    const advertised = async (extra: Record<string, string>) => {
      const sandbox = sandboxFromEnvironment(configured(), never);
      const launcher = sandbox.launcher({
        settings: loadSettings({ ...BASE, ...extra }),
        logger: recordingLogger(),
        background: () => undefined,
      });
      return {
        launcher,
        engines: await launcher.capabilities(new AbortController().signal),
      };
    };

    it("includes `implementer` when an app of this deployment names the kind, and has a probe that proves it", async () => {
      const { launcher, engines } = await advertised(FACTORY);

      expect(engines).toStrictEqual(["pr-agent", "opencode", "implementer"]);
      expect(launcher.probe).toBeDefined();
    });

    it("advertises exactly what it always did when no app names the kind: the reviewer's key never gets it", async () => {
      const { engines } = await advertised({});

      expect(engines).toStrictEqual(["pr-agent", "opencode"]);
    });

    it("advertises exactly the two reviewer engines when DISPATCHER_ENGINES names only those, with no app that has the kind", async () => {
      const { engines } = await advertised({
        DISPATCHER_ENGINES: "pr-agent,opencode",
      });

      expect(engines).toStrictEqual(["pr-agent", "opencode"]);
    });
  });

  // #364-T18
  it("loads the SDK only when the reaper first lists, not at start", () => {
    let loads = 0;
    const sandbox = sandboxFromEnvironment(configured(), () => {
      loads += 1;
      return Promise.reject(new Error("not loaded"));
    });

    sandbox.reaper?.(loadSettings(BASE));

    expect(loads).toBe(0);
  });
});

describe("the probe's configuration from the environment", () => {
  const launcherFor = (
    env: Record<string, string>,
    extra: Record<string, string> = {},
    logger = recordingLogger(),
  ) =>
    sandboxFromEnvironment(env, never).launcher({
      settings: loadSettings({ ...BASE, ...extra }),
      logger,
      background: () => undefined,
    });

  // #479-T04
  it("advertises opencode at once, with no proof in between, and keeps a probe for POST /probe only", async () => {
    const launcher = launcherFor(configured());
    const signal = new AbortController().signal;

    expect(launcher.probe).toBeTypeOf("function");
    expect(await launcher.capabilities(signal)).toStrictEqual([
      "pr-agent",
      "opencode",
    ]);
  });

  // #331-T02
  it("starts no probe for a deployment that is configured for Diff jobs only", async () => {
    const launcher = launcherFor(configured(), {
      DISPATCHER_ENGINES: "pr-agent",
    });

    expect(launcher.probe).toBeUndefined();
  });

  // #479-T07
  it("accepts DISPATCHER_PROBE_TTL_SECONDS, whatever it holds, with a deprecation warning and no other effect", () => {
    for (const value of ["59", "86401", "hour", "3600"]) {
      const logger = recordingLogger();

      const launcher = launcherFor(
        configured({ DISPATCHER_PROBE_TTL_SECONDS: value }),
        {},
        logger,
      );

      expect(launcher.probe).toBeTypeOf("function");
      expect(logger.text()).toContain("deprecated_setting");
      expect(logger.text()).toContain("DISPATCHER_PROBE_TTL_SECONDS");
    }
  });

  // #479-T07
  it("does not warn when the deprecated variable is not set", () => {
    const logger = recordingLogger();

    launcherFor(configured(), {}, logger);

    expect(logger.text()).not.toContain("deprecated_setting");
  });

  // #331-T03
  it.each<[string, Record<string, string>, string]>([
    [
      "a probe time of 29 seconds",
      configured({ DISPATCHER_PROBE_TIMEOUT_SECONDS: "29" }),
      "DISPATCHER_PROBE_TIMEOUT_SECONDS",
    ],
    [
      "a probe time above ten minutes",
      configured({ DISPATCHER_PROBE_TIMEOUT_SECONDS: "601" }),
      "DISPATCHER_PROBE_TIMEOUT_SECONDS",
    ],
  ])("refuses %s and names the variable", (_what, env, variable) => {
    expect(refusal(env).variable).toBe(variable);
  });

  // #331-T03
  it("accepts the probe time at its bounds", () => {
    for (const timeout of ["30", "150", "600"])
      expect(() =>
        sandboxFromEnvironment(
          configured({ DISPATCHER_PROBE_TIMEOUT_SECONDS: timeout }),
          never,
        ),
      ).not.toThrow();
  });

  // #331-T09
  it.each<[string, Record<string, string>, string]>([
    [
      "a capability descriptor that is not JSON",
      configured({ RUNNER_DYNAMIC_CAPABILITIES: "tools" }),
      "RUNNER_DYNAMIC_CAPABILITIES",
    ],
    [
      "a capability descriptor that is not an object",
      configured({ RUNNER_DYNAMIC_CAPABILITIES: "[1]" }),
      "RUNNER_DYNAMIC_CAPABILITIES",
    ],
    [
      "a capability descriptor with a line break",
      configured({ RUNNER_DYNAMIC_CAPABILITIES: '{"a":1,\n"b":2}' }),
      "RUNNER_DYNAMIC_CAPABILITIES",
    ],
    [
      "a cost limit that is not a number",
      configured({ RUNNER_DYNAMIC_MAX_COST_USD: "free" }),
      "RUNNER_DYNAMIC_MAX_COST_USD",
    ],
    [
      "a cost limit of zero",
      configured({ RUNNER_DYNAMIC_MAX_COST_USD: "0" }),
      "RUNNER_DYNAMIC_MAX_COST_USD",
    ],
    [
      "a negative cost limit",
      configured({ RUNNER_DYNAMIC_MAX_COST_USD: "-1" }),
      "RUNNER_DYNAMIC_MAX_COST_USD",
    ],
    [
      "a cost limit in exponent form",
      configured({ RUNNER_DYNAMIC_MAX_COST_USD: "1e3" }),
      "RUNNER_DYNAMIC_MAX_COST_USD",
    ],
  ])("refuses %s at start and names the variable", (_what, env, variable) => {
    // At start: when the launcher is built, which is when the Dispatcher starts.
    expect(() => launcherFor(env)).toThrowError(new RegExp(variable));
  });

  // #331-R07
  it("does not refuse a malformed Dynamic configuration of a deployment that serves no Dynamic job", () => {
    const env = configured({
      RUNNER_DYNAMIC_CAPABILITIES: "tools",
      RUNNER_DYNAMIC_MAX_COST_USD: "free",
    });

    expect(() =>
      launcherFor(env, { DISPATCHER_ENGINES: "pr-agent" }),
    ).not.toThrow();
    expect(() => launcherFor(env)).toThrow();
  });

  // #331-R03
  it.each<[string, string]>([
    ["-1", "DISPATCHER_PROBE_REUSE_SECONDS"],
    ["601", "DISPATCHER_PROBE_REUSE_SECONDS"],
    ["soon", "DISPATCHER_PROBE_REUSE_SECONDS"],
  ])("refuses a reuse time of %s and names the variable", (value, variable) => {
    expect(
      refusal(configured({ DISPATCHER_PROBE_REUSE_SECONDS: value })).variable,
    ).toBe(variable);
  });

  // #331-R03
  it("accepts a reuse time of 0 (every forced probe runs) and of 600", () => {
    for (const value of ["0", "60", "600"])
      expect(() =>
        sandboxFromEnvironment(
          configured({ DISPATCHER_PROBE_REUSE_SECONDS: value }),
          never,
        ),
      ).not.toThrow();
  });

  // #331-T09
  it("accepts the operator's Dynamic configuration as the self-hosted service has it", () => {
    expect(() =>
      launcherFor(
        configured({
          RUNNER_DYNAMIC_CAPABILITIES:
            '{"tool_choice_required":true,"max_output_tokens":4096}',
          RUNNER_DYNAMIC_MAX_COST_USD: "2.50",
        }),
      ),
    ).not.toThrow();
  });
});
