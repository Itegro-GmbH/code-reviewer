// SPDX-License-Identifier: LicenseRef-Proprietary

import { beforeEach, describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import { createDispatcherCore } from "../core/dispatcher.ts";
import { LaunchError, type LaunchSpec, type Launcher } from "../core/types.ts";
import {
  DISPATCHER_TOKEN,
  recordingLogger,
  settingsFor,
  startApp,
  waitFor,
  type RecordedLogger,
} from "../test-support/harness.ts";
import { ManualClock, settle } from "../test-support/manual-clock.ts";
import { DEFAULT_CONFIG } from "../snapshot/config.ts";
import { PATHS } from "../snapshot/scripts.ts";
import { WORKER_CONTAINER_SPEC } from "./container-spec.ts";
import { VM_PREPARE_PATH } from "./sandbox-host.ts";
import {
  SANDBOX_HANDOVER_SECONDS,
  SANDBOX_IMAGE_REFERENCE,
  SANDBOX_REGION,
  SANDBOX_KIND_DEFAULTS,
  IMPLEMENTER_LAUNCH_EXTRA_SECONDS,
  RUN_DIRECTORY_STEPS_SECONDS,
  SYSBOX_PREPARE_SECONDS,
  WORK_VOLUME_STEPS_SECONDS,
  minimumVmTimeoutMargin,
  agentMemoryMb,
  IMPLEMENTER_VM_HEADROOM_MB,
  MODEL_DOOR_MEMORY_MB,
  READER_MEMORY_MB,
  SANDBOX_MEMORY_PER_VCPU_MB,
  implementerEnvironment,
  planForKind,
  validateKindConfig,
  VM_TIMEOUT_MARGIN_SECONDS,
  createSandboxLauncher,
  type SandboxLauncherOptions,
} from "./sandbox.ts";
import {
  SANDBOX_FAILURE_KINDS,
  SandboxServiceError,
  type SandboxFailureKind,
} from "./sandbox-service.ts";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const OTHER_IMAGE_ID = `sha256:${"b".repeat(64)}`;
const SNAPSHOT_ID = "snap_dummy_golden_0001";
const CREDENTIAL = "crj_dummy-credential-0123456789-abcdefghijklmnopq";
const JOB_ID = "00000000-0000-4000-8000-000000000001";

let service: FakeSandboxService;
let clock: ManualClock;
let logger: RecordedLogger;

beforeEach(() => {
  service = new FakeSandboxService();
  service.onExec("image-id", { stdout: `${IMAGE_ID}\n` });
  clock = new ManualClock();
  logger = recordingLogger();
});

function build(overrides: Partial<SandboxLauncherOptions> = {}): Launcher {
  return createSandboxLauncher({
    service,
    snapshotId: SNAPSHOT_ID,
    imageDigest: IMAGE_ID,
    logger,
    clock,
    ...overrides,
  });
}

function spec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    appId: "reviewer",
    appUrl: "https://app.example.invalid",
    jobId: JOB_ID,
    credential: CREDENTIAL,
    kind: "diff",
    timeoutSeconds: 1200,
    config: {},
    ...overrides,
  };
}

/** Starts a launch, lets the clock run through the hand-over wait and returns how it ended. */
async function launch(
  launcher: Launcher,
  launchSpec: LaunchSpec = spec(),
  signal: AbortSignal = new AbortController().signal,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const ended = launcher.launch(launchSpec, signal).then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  await settle();
  await clock.advance(SANDBOX_HANDOVER_SECONDS * 1000);
  return ended;
}

function failure(result: Awaited<ReturnType<typeof launch>>): LaunchError {
  if (result.ok) throw new Error("the launch was expected to fail");
  expect(result.error).toBeInstanceOf(LaunchError);
  return result.error as LaunchError;
}

const dockerRun = () => service.starts.find((s) => s.label === "docker-run");

function valuesOf(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag ? [args[index + 1] ?? ""] : [],
  );
}

describe("the Sandbox-Launcher", () => {
  // #493-T05
  it("tells the core about the VM right after the create returned, with the name of the platform and the VM's own timeout", async () => {
    const created: Array<{
      name: string;
      startedAt: Date;
      timeoutSeconds: number;
    }> = [];
    const launcher = build({ now: () => new Date("2026-10-19T10:00:00.000Z") });

    const result = await launch(
      launcher,
      spec({ onVmCreated: (vm) => created.push(vm) }),
    );

    expect(result).toStrictEqual({ ok: true });
    expect(created).toStrictEqual([
      {
        name: service.creates[0]?.name,
        startedAt: new Date("2026-10-19T10:00:00.000Z"),
        timeoutSeconds: 1200 + VM_TIMEOUT_MARGIN_SECONDS,
      },
    ]);
    // Before anything else is done to the VM.
    expect(service.events[0]).toBe(`create:${created[0]?.name}`);
  });

  // #493-T05
  it("does not tell the core about a VM whose create failed, and a callback that throws changes nothing", async () => {
    const created: unknown[] = [];
    service.failNextCreate(new SandboxServiceError("unavailable"));
    const failed = await launch(
      build(),
      spec({ onVmCreated: (vm) => created.push(vm) }),
    );
    expect(failed.ok).toBe(false);
    expect(created).toStrictEqual([]);

    const result = await launch(
      build(),
      spec({
        onVmCreated: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(result).toStrictEqual({ ok: true });
  });

  // #329-T01
  it("creates a VM from the golden snapshot, prepares the host, runs the container and delivers the start document on stdin", async () => {
    const launcher = build();

    const result = await launch(launcher);

    expect(result).toStrictEqual({ ok: true });
    expect(service.creates).toHaveLength(1);
    const [created] = service.creates;
    expect(created?.snapshotId).toBe(SNAPSHOT_ID);
    const name = created?.name ?? "";
    expect(service.events).toStrictEqual([
      `create:${name}`,
      "exec:vm-prepare",
      "exec:image-id",
      "start:docker-run",
      `stdin:${name}`,
    ]);
    // The cgroup fix and dockerd run as root, from the golden snapshot's script.
    expect(service.execs[0]).toMatchObject({
      label: "vm-prepare",
      cmd: "/usr/local/sbin/vm-prepare.sh",
      args: [],
      sudo: true,
    });
    const run = dockerRun();
    expect(run).toMatchObject({ cmd: "docker", sudo: true });
    const args = run?.args ?? [];
    expect(args[0]).toBe("run");
    expect(args).toContain("--read-only");
    expect(valuesOf(args, "--cap-drop")).toStrictEqual(["ALL"]);
    expect(valuesOf(args, "--security-opt")).toStrictEqual([
      "no-new-privileges:true",
    ]);
    // The IPv6 switches of the Sandbox variant, for every kind (#345).
    expect(valuesOf(args, "--sysctl")).toStrictEqual([
      "net.ipv6.conf.all.disable_ipv6=1",
      "net.ipv6.conf.default.disable_ipv6=1",
    ]);
    // The image that was verified is the image that runs, by id.
    expect(args.slice(-2)).toStrictEqual([IMAGE_ID, "worker-once"]);
    expect(valuesOf(args, "--env")).toContain(
      "RUNNER_JOB_TIMEOUT_SECONDS=1200",
    );
    expect(JSON.parse(service.stdinOf(name))).toStrictEqual({
      appUrl: "https://app.example.invalid",
      jobId: JOB_ID,
      credential: CREDENTIAL,
    });
    expect(service.stdinClosed(name)).toBe(true);
  });

  // #331-T09
  it("gives a Dynamic job the operator's Dynamic configuration and a Diff job none of it", async () => {
    const dynamicEnvironment = {
      RUNNER_DYNAMIC_CAPABILITIES: '{"tool_choice_required":true}',
      RUNNER_DYNAMIC_MAX_COST_USD: "2.5",
    };
    const launcher = build({ dynamicEnvironment });

    await launch(launcher, spec({ kind: "dynamic" }));
    await launch(
      launcher,
      spec({ kind: "diff", jobId: "00000000-0000-4000-8000-000000000002" }),
    );

    const [dynamic, diff] = service.starts.map((call) =>
      valuesOf(call.args, "--env"),
    );
    expect(dynamic).toContain("RUNNER_DYNAMIC_MAX_COST_USD=2.5");
    expect(dynamic).toContain(
      'RUNNER_DYNAMIC_CAPABILITIES={"tool_choice_required":true}',
    );
    expect(dynamic).toContain("HOME=/home/runner");
    expect(diff?.some((entry) => entry.startsWith("RUNNER_DYNAMIC"))).toBe(
      false,
    );
  });

  // #331-T09
  it("passes nothing of the kind when the operator configured nothing", async () => {
    await launch(build(), spec({ kind: "dynamic" }));

    const environment = valuesOf(dockerRun()?.args ?? [], "--env");
    expect(
      environment.some((entry) => entry.startsWith("RUNNER_DYNAMIC")),
    ).toBe(false);
  });

  // #329-T02
  it("puts the credential on the stdin pipe and nowhere else: no argument, no environment, no file, no log line", async () => {
    const launcher = build();

    await launch(launcher);
    service.exitProcess(service.creates[0]?.name ?? "", 0);
    await settle();

    const name = service.creates[0]?.name ?? "";
    expect(service.stdinOf(name)).toContain(CREDENTIAL);
    expect(service.requestText()).not.toContain(CREDENTIAL);
    expect(logger.text()).not.toContain(CREDENTIAL);
    // The port has no way to set an environment or write a file on the VM; the requests prove it.
    for (const call of [...service.execs, ...service.starts])
      expect(Object.keys(call).sort()).not.toContain("env");
    expect(service.requestText()).not.toContain("writeFile");
  });

  // #329-T03
  it("creates the VM in fra1 without persistence, without a failover region and under a name no earlier VM had", async () => {
    const launcher = build();

    await launch(launcher);
    await launch(launcher);

    const [first, second] = service.creates;
    expect(first).toMatchObject({
      region: "fra1",
      persistent: false,
      snapshotId: SNAPSHOT_ID,
    });
    expect(SANDBOX_REGION).toBe("fra1");
    expect(Object.keys(first ?? {}).sort()).toStrictEqual([
      "name",
      "persistent",
      "region",
      "snapshotId",
      "tags",
      "timeoutMs",
      "vcpus",
    ]);
    // The same job twice (a second attempt) gets a new name, and the name carries the job.
    expect(first?.name).toMatch(/^cr-diff-[a-z0-9-]+-[a-z0-9]{8}$/);
    expect(first?.name).toContain(JOB_ID);
    expect(first?.name.length).toBeLessThanOrEqual(63);
    expect(second?.name).not.toBe(first?.name);
    expect(first?.tags).toStrictEqual({
      app: "code-reviewer",
      kind: "diff",
      job: JOB_ID,
      // #730: every job VM names the app that claimed its job.
      tenant: "reviewer",
    });
  });

  // #730-T12
  it("tags the VM of a factory job with the factory as its tenant and keeps the name format", async () => {
    const launcher = build();

    await launch(launcher, spec({ appId: "factory" }));
    await launch(launcher, spec({ appId: "reviewer" }));

    const [factoryVm, reviewerVm] = service.creates;
    expect(factoryVm?.tags).toStrictEqual({
      app: "code-reviewer",
      kind: "diff",
      job: JOB_ID,
      tenant: "factory",
    });
    expect(reviewerVm?.tags.tenant).toBe("reviewer");
    // The name does not carry the app: `cr-<kind>-<job id>-<8 hex>`, which the reaper and the stop route match.
    expect(factoryVm?.name).toMatch(
      new RegExp(`^cr-diff-${JOB_ID}-[0-9a-f]{8}$`),
    );
    expect(factoryVm?.name).not.toContain("factory");
  });

  // #329-T04
  it.each<[SandboxFailureKind, string, boolean]>([
    ["rate_limited", "sandbox_rate_limited", true],
    ["quota_exceeded", "sandbox_quota_exceeded", true],
    ["network", "sandbox_network", true],
    ["unavailable", "sandbox_unavailable", true],
    ["not_ready", "image_not_ready", true],
    ["snapshot_missing", "sandbox_snapshot_missing", false],
    ["region_mismatch", "sandbox_region_mismatch", false],
    ["rejected", "sandbox_rejected", false],
    ["auth_failed", "sandbox_auth_failed", false],
  ])(
    "turns a failed create (%s) into LaunchError %s, retryable %s",
    async (kind, code, retryable) => {
      service.failNextCreate(new SandboxServiceError(kind));

      const error = failure(await launch(build()));

      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.message).toBe(code);
      expect(service.starts).toHaveLength(0);
    },
  );

  // #329-T04
  it("covers every failure kind of the port", () => {
    expect(SANDBOX_FAILURE_KINDS).toHaveLength(9);
  });

  // #329-T04
  it("turns an error it does not know into a non-retryable launch error without its text", async () => {
    service.failNextCreate(new Error("secret platform text 12345"));

    const error = failure(await launch(build()));

    expect(error.code).toBe("sandbox_create_failed");
    expect(error.retryable).toBe(false);
    expect(logger.text()).not.toContain("12345");
  });

  // #329-T04
  it("does not stop by name after a refusal, but does after a failure that may have created the VM", async () => {
    service.failNextCreate(new SandboxServiceError("rate_limited"));
    await launch(build());
    expect(service.stops).toStrictEqual([]);

    service.failNextCreate(new SandboxServiceError("network"));
    await launch(build());
    expect(service.stops).toHaveLength(1);
    expect(service.stops[0]).toBe(service.creates[1]?.name);
  });

  // #329-T05
  it("stops the VM and fails the launch when the daemon does not become ready", async () => {
    service.onExec("vm-prepare", {
      exitCode: 1,
      stderr: "dockerd did not become ready",
    });

    const error = failure(await launch(build()));

    expect(error.code).toBe("docker_not_ready");
    expect(error.retryable).toBe(true);
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
    expect(service.starts).toHaveLength(0);
    expect(service.running()).toStrictEqual([]);
  });

  // #473-T03
  it("logs a stable code and the redacted tail of the stderr of a failed vm-prepare.sh", async () => {
    service.onExec("vm-prepare", {
      exitCode: 1,
      stderr: `vm-prepare: cgroup_root_busy tries=100 last_error=Device or resource busy\ncrj_${"A".repeat(43)}\n`,
    });

    await launch(build());

    const line = logger.lines.find((entry) =>
      entry.startsWith("warn vm_prepare_failed "),
    );
    expect(line).toBeDefined();
    expect(line).toContain('"code":"docker_not_ready"');
    expect(line).toContain('"exitCode":1');
    expect(line).toContain(`"jobId":"${JOB_ID}"`);
    expect(line).toContain("cgroup_root_busy tries=100");
    expect(line).toContain("[redacted]");
    expect(line).not.toContain("crj_AAAA");
  });

  // #329-T06
  it("refuses an image whose id is not the configured digest and stops the VM", async () => {
    service.onExec("image-id", { stdout: `${OTHER_IMAGE_ID}\n` });

    const error = failure(await launch(build()));

    expect(error.code).toBe("image_mismatch");
    expect(error.retryable).toBe(false);
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
    expect(service.starts).toHaveLength(0);
    expect(service.stdinOf(service.creates[0]?.name ?? "")).toBe("");
    // The ids are not secrets, but the log holds codes only.
    expect(logger.text()).not.toContain(OTHER_IMAGE_ID);
  });

  // #329-T06
  it("fails with image_missing when the VM has no such image", async () => {
    service.onExec("image-id", { exitCode: 1, stderr: "No such image" });

    const error = failure(await launch(build()));

    expect(error.code).toBe("image_missing");
    expect(service.stops).toHaveLength(1);
    expect(service.starts).toHaveLength(0);
  });

  // #329-T07
  it("sets the VM timeout as the backstop", async () => {
    await launch(build());

    expect(service.creates[0]?.timeoutMs).toBe(
      (1200 + VM_TIMEOUT_MARGIN_SECONDS) * 1000,
    );
    expect(VM_TIMEOUT_MARGIN_SECONDS).toBe(300);
  });

  // #487-T04
  it("holds nothing after the hand-over: no pending wait, no background work, no stop, and no way to ask for either", async () => {
    const launcher = build();

    const result = await launch(launcher);

    expect(result).toStrictEqual({ ok: true });
    // The wait that told the hand-over from an early end is over: nobody watches the container any more.
    expect(service.pendingWaits()).toBe(0);
    expect(service.stops).toStrictEqual([]);
    expect("idle" in launcher).toBe(false);
  });

  // #487-T04
  it("does nothing when the container ends after the hand-over: the VM is stopped by the App's stop call, not by the Launcher", async () => {
    const launcher = build();
    await launch(launcher);
    const name = service.creates[0]?.name ?? "";

    service.exitProcess(name, 2);
    await settle();
    await clock.advance(120_000);

    expect(service.stops).toStrictEqual([]);
    expect(service.running()).toStrictEqual([name]);
    expect(logger.text()).not.toContain("worker_exited");
    expect(logger.text()).not.toContain("worker_wait_failed");
  });

  // #487-T04
  it("does not ask for the container's end again when a wait breaks after the hand-over", async () => {
    const launcher = build();
    await launch(launcher);
    const name = service.creates[0]?.name ?? "";

    service.dropWaits(name, new Error("the log stream broke"));
    await settle();
    await clock.advance(120_000);

    expect(service.pendingWaits()).toBe(0);
    expect(service.stops).toStrictEqual([]);
  });

  // #329-T07
  it("resolves when the container has run through the hand-over wait, not when it ends", async () => {
    const launcher = build();

    const result = await launch(launcher);

    expect(result).toStrictEqual({ ok: true });
    expect(service.running()).toStrictEqual([service.creates[0]?.name]);
  });

  // #329-T07
  it("treats a container that ended with 0 before the wait is over as handed over", async () => {
    const launcher = build();
    const ended = launcher.launch(spec(), new AbortController().signal);
    await settle();
    service.exitProcess(service.creates[0]?.name ?? "", 0);

    await expect(ended).resolves.toBeUndefined();
    expect(service.stops).toStrictEqual([]);
  });

  // #329-T07
  it("fails the launch when the container ends with an error before the hand-over", async () => {
    const launcher = build();
    const ended = launcher.launch(spec(), new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await settle();
    service.exitProcess(service.creates[0]?.name ?? "", 2);

    const error = (await ended) as LaunchError;

    expect(error).toBeInstanceOf(LaunchError);
    expect(error.code).toBe("worker_exited_early");
    expect(error.retryable).toBe(true);
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
  });

  // #329-T08
  it("kills the container and stops the VM by name when the signal aborts during the hand-over", async () => {
    const launcher = build();
    const stop = new AbortController();
    const ended = launcher.launch(spec(), stop.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await settle();

    stop.abort();
    const error = (await ended) as LaunchError;

    expect(error.code).toBe("launch_aborted");
    const name = service.creates[0]?.name ?? "";
    expect(service.stops).toStrictEqual([name]);
    expect(service.execs.map((e) => e.label)).toContain("docker-kill");
    const kill = service.execs.find((e) => e.label === "docker-kill");
    expect(kill?.args).toStrictEqual([
      "kill",
      `code-reviewer-worker-${JOB_ID}`,
    ]);
    expect(service.running()).toStrictEqual([]);
  });

  // #329-T08
  it("stops the VM by name when the signal aborts while it is being created", async () => {
    const hold = service.holdNextCreate();
    const launcher = build();
    const stop = new AbortController();
    const ended = launcher.launch(spec(), stop.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await settle();

    stop.abort();
    const error = (await ended) as LaunchError;
    hold.release();

    expect(error).toBeInstanceOf(LaunchError);
    expect(error.code).toBe("launch_aborted");
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
  });

  // #329-T08
  it("does not tie the Worker's life to the signal after the hand-over", async () => {
    const launcher = build();
    const stop = new AbortController();
    await launch(launcher, spec(), stop.signal);

    stop.abort();
    await settle();

    expect(service.stops).toStrictEqual([]);
    expect(service.running()).toStrictEqual([service.creates[0]?.name]);
  });

  // #329-T11
  it("gives each Worker kind its own VM size and container memory limit from configuration", async () => {
    const launcher = build();

    await launch(
      launcher,
      spec({
        kind: "dynamic",
        config: {
          launcher: { vcpus: 2 },
          container: { memory: { limit: "3g", reservation: "2g" } },
        },
      }),
    );
    await launch(launcher, spec({ kind: "diff", config: {} }));

    const [dynamic, diff] = service.starts;
    const [dynamicVm, diffVm] = service.creates;
    expect(dynamicVm?.vcpus).toBe(2);
    expect(valuesOf(dynamic?.args ?? [], "--memory")).toStrictEqual(["3g"]);
    expect(valuesOf(dynamic?.args ?? [], "--memory-swap")).toStrictEqual([
      "3g",
    ]);
    expect(valuesOf(dynamic?.args ?? [], "--memory-reservation")).toStrictEqual(
      ["2g"],
    );
    expect(dynamicVm?.tags.kind).toBe("dynamic");
    // The default of a kind with no configuration: the smallest VM, 1.5 GB for the container.
    expect(diffVm?.vcpus).toBe(1);
    expect(valuesOf(diff?.args ?? [], "--memory")).toStrictEqual(["1536m"]);
    expect(valuesOf(diff?.args ?? [], "--memory-swap")).toStrictEqual([
      "1536m",
    ]);
  });

  // #329-T11
  it("uses a changed value without a code change", async () => {
    const launcher = build();

    await launch(launcher, spec({ config: { launcher: { vcpus: 4 } } }));
    await launch(
      launcher,
      spec({
        config: {
          launcher: { vcpus: 4 },
          container: { memory: { limit: "6g" } },
        },
      }),
    );

    expect(service.creates.map((created) => created.vcpus)).toStrictEqual([
      4, 4,
    ]);
    expect(valuesOf(service.starts[0]?.args ?? [], "--memory")).toStrictEqual([
      "1536m",
    ]);
    expect(valuesOf(service.starts[1]?.args ?? [], "--memory")).toStrictEqual([
      "6g",
    ]);
  });

  // #329-T11
  it("refuses a container limit that leaves the VM no room for the OS and dockerd", async () => {
    const error = failure(
      await launch(
        build(),
        spec({ config: { container: { memory: { limit: "2g" } } } }),
      ),
    );

    expect(error.code).toBe("sandbox_config_invalid");
    expect(service.creates).toStrictEqual([]);
  });

  // #745-T15: the model door and the reader are more containers of an implementer turn, and the VM holds them beside the Worker.
  it("keeps room for the model door and the reader beside the Worker of an implementer turn, and for none beside a review's", async () => {
    // 2 vCPU are 4096 MB: a review keeps 256 for the OS and dockerd; a turn keeps 512 for them and the Sysbox daemons, 256 for
    // the door and 256 for the reader. 3600m fits a review but not a turn; 3072m is the most a turn takes.
    const config = {
      launcher: { vcpus: 2 },
      container: { memory: { limit: "3600m", reservation: "3g" } },
    };

    expect(() => validateKindConfig("dynamic", config)).not.toThrow();
    expect(() => validateKindConfig("implementer", config)).toThrow(
      LaunchError,
    );
    expect(() =>
      validateKindConfig("implementer", {
        launcher: { vcpus: 2 },
        container: { memory: { limit: "3072m", reservation: "3g" } },
      }),
    ).not.toThrow();
    expect(() =>
      validateKindConfig("implementer", {
        launcher: { vcpus: 2 },
        container: { memory: { limit: "3073m", reservation: "3g" } },
      }),
    ).toThrow(LaunchError);
  });

  // #329-T11
  it.each<[string, Record<string, string | number | boolean>]>([
    ["a VM size the platform does not have", { vcpus: 3 }],
    ["a VM size that is not a number", { vcpus: "two" }],
    ["too many vCPUs", { vcpus: 16 }],
    ["an option it does not know", { vcpus: 1, region: "iad1" }],
  ])("refuses %s before it creates anything", async (_what, options) => {
    const error = failure(
      await launch(build(), spec({ config: { launcher: options } })),
    );

    expect(error.code).toBe("sandbox_config_invalid");
    expect(error.retryable).toBe(false);
    expect(service.creates).toStrictEqual([]);
  });

  // #329-T11
  it("refuses a memory override that weakens the container before it creates anything", async () => {
    const error = failure(
      await launch(
        build(),
        spec({
          config: { container: { memory: { limit: "1g", reservation: "2g" } } },
        }),
      ),
    );

    expect(error.code).toBe("sandbox_config_invalid");
    expect(service.creates).toStrictEqual([]);
  });

  // #329 (additional): capabilities
  it("advertises the two reviewer engines unless told otherwise: the deploy canary is the proof, the deployment's engines decide (#479)", async () => {
    const signal = new AbortController().signal;

    expect(await build().capabilities(signal)).toStrictEqual([
      "pr-agent",
      "opencode",
    ]);
    expect(
      await build({
        capabilities: () => Promise.resolve(["pr-agent"]),
      }).capabilities(signal),
    ).toStrictEqual(["pr-agent"]);
  });

  // #745-T29: with the VM's disk full Docker can still run a command in a container (the pipes of an exec are files below
  // /run), so those directories are memory, made before the daemon starts, on an implementer's VM only
  it("puts the directories Docker keeps its runtime in on memory before the daemon starts, for an implementer's VM and no other", async () => {
    await launch(build(), spec({ kind: "implementer" }));
    await launch(
      build(),
      spec({ kind: "diff", jobId: "00000000-0000-4000-8000-000000000002" }),
    );

    const first = service.execs.filter(
      (call) => call.vm === service.creates[0]?.name,
    );
    expect(
      first.slice(0, 4).map((call) => [call.label, call.cmd, ...call.args]),
    ).toStrictEqual([
      [
        "run-directories",
        "mkdir",
        "-p",
        "--",
        "/run/docker",
        "/run/containerd",
      ],
      [
        "run-directory-docker",
        "mount",
        "-t",
        "tmpfs",
        "-o",
        "size=64m,mode=0711,nosuid,nodev",
        "tmpfs",
        "/run/docker",
      ],
      [
        "run-directory-containerd",
        "mount",
        "-t",
        "tmpfs",
        "-o",
        "size=64m,mode=0711,nosuid,nodev",
        "tmpfs",
        "/run/containerd",
      ],
      ["vm-prepare", "/usr/local/sbin/vm-prepare.sh"],
    ]);
    for (const call of first.slice(0, 3)) expect(call.sudo).toBe(true);
    const second = service.execs.filter(
      (call) => call.vm === service.creates[1]?.name,
    );
    expect(second.some((call) => call.label.startsWith("run-director"))).toBe(
      false,
    );
  });

  // #745-T29
  it.each([
    "run-directories",
    "run-directory-docker",
    "run-directory-containerd",
  ])(
    "stops the VM with the retryable docker_not_ready when %s fails, and runs nothing after it",
    async (label) => {
      service.onExec(label, { exitCode: 32, stderr: "mount: nope" });

      const error = failure(
        await launch(build(), spec({ kind: "implementer" })),
      );

      expect(error.code).toBe("docker_not_ready");
      expect(error.retryable).toBe(true);
      expect(service.stops).toStrictEqual([service.creates[0]?.name]);
      expect(service.execs.some((call) => call.label === "vm-prepare")).toBe(
        false,
      );
      expect(service.starts).toHaveLength(0);
    },
  );

  // #760-T05
  it("makes the work volume of an implementer job after the host is prepared (Sysbox included) and before docker run, all on the job's VM", async () => {
    const result = await launch(build(), spec({ kind: "implementer" }));

    expect(result).toStrictEqual({ ok: true });
    const name = service.creates[0]?.name ?? "";
    expect(service.events).toStrictEqual([
      `create:${name}`,
      "exec:run-directories",
      "exec:run-directory-docker",
      "exec:run-directory-containerd",
      "exec:vm-prepare",
      "exec:image-id",
      "exec:sysbox-prepare",
      "exec:work-volume-dir",
      "exec:work-volume-reserve-image",
      "exec:work-volume-reserve-fs",
      "exec:work-volume-reserve-mount",
      "exec:work-volume-mount",
      "exec:work-volume-options",
      "exec:work-volume-check",
      "exec:work-volume-create",
      "start:docker-run",
      `stdin:${name}`,
    ]);
    // Everything happens in the one VM and as root; the volume is the VM's, so it goes with the VM.
    for (const call of service.execs) expect(call.vm).toBe(name);
    for (const call of service.execs.filter((c) =>
      c.label.startsWith("work-volume"),
    ))
      expect(call.sudo).toBe(true);
    const volume = `code-reviewer-work-${JOB_ID}`;
    const directory = `/var/lib/code-reviewer-work/${volume}`;
    expect(
      service.execs.find((call) => call.label === "work-volume-options"),
    ).toMatchObject({
      cmd: "mount",
      args: ["-o", "remount,bind,rw,nosuid,nodev", directory],
    });
    expect(
      service.execs.find((call) => call.label === "work-volume-create")?.args,
    ).toContain(volume);
    expect(service.creates[0]?.tags.kind).toBe("implementer");
    expect(service.stops).toStrictEqual([]);
  });

  // #760-T02
  it("starts an implementer job in the implementer profile: 2 vCPU, a 768 MB container, 2048 processes, the work volume, the Docker socket and the names", async () => {
    await launch(build(), spec({ kind: "implementer" }));

    const args = dockerRun()?.args ?? [];
    expect(service.creates[0]?.vcpus).toBe(2);
    expect(valuesOf(args, "--memory")).toStrictEqual(["768m"]);
    expect(valuesOf(args, "--memory-reservation")).toStrictEqual(["512m"]);
    expect(valuesOf(args, "--memory-swap")).toStrictEqual(["768m"]);
    expect(valuesOf(args, "--pids-limit")).toStrictEqual(["2048"]);
    expect(valuesOf(args, "--mount")).toStrictEqual([
      `type=volume,source=code-reviewer-work-${JOB_ID},target=/work`,
      "type=bind,source=/var/run/docker.sock,target=/run/docker.sock,readonly",
    ]);
    expect(args).toContain("--read-only");
    // The Sandbox additions apply to every kind.
    expect(valuesOf(args, "--sysctl")).toHaveLength(2);
    expect(valuesOf(args, "--env")).toStrictEqual([
      "HOME=/home/runner",
      "RUNNER_DIFF_JOB_USER=10001:10001",
      "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB=2304",
      "RUNNER_IMPLEMENTER_MODEL_DOOR=docker",
      "RUNNER_IMPLEMENTER_SANDBOX_PROOF=unproven",
      "RUNNER_IMPLEMENTER_WORK_DIR=/work",
      "RUNNER_JOB_TIMEOUT_SECONDS=1200",
    ]);
  });

  // #760-T03
  it("does not give a Diff or a Dynamic job a work volume, a mount or the names of the Implementer", async () => {
    const launcher = build({
      dynamicEnvironment: { RUNNER_DYNAMIC_MAX_COST_USD: "2.5" },
    });

    await launch(launcher, spec({ kind: "diff" }));
    await launch(
      launcher,
      spec({ kind: "dynamic", jobId: "00000000-0000-4000-8000-000000000002" }),
    );

    expect(service.execs.map((call) => call.label)).toStrictEqual([
      "vm-prepare",
      "image-id",
      "vm-prepare",
      "image-id",
    ]);
    for (const call of service.starts) {
      expect(call.args).not.toContain("--mount");
      expect(valuesOf(call.args, "--pids-limit")).toStrictEqual(["512"]);
      expect(
        valuesOf(call.args, "--env").filter((entry) =>
          entry.startsWith("RUNNER_IMPLEMENTER"),
        ),
      ).toStrictEqual([]);
    }
  });

  // #760-T02
  it("does not hand the operator's Dynamic configuration to an implementer job: its cost ceiling is not Dynamic's", async () => {
    await launch(
      build({ dynamicEnvironment: { RUNNER_DYNAMIC_MAX_COST_USD: "2.5" } }),
      spec({ kind: "implementer" }),
    );

    expect(
      valuesOf(dockerRun()?.args ?? [], "--env").filter((entry) =>
        entry.startsWith("RUNNER_DYNAMIC"),
      ),
    ).toStrictEqual([]);
  });

  // #760-T04
  it("takes the VM size and the container memory of an implementer job from its configuration, value by value", async () => {
    await launch(
      build(),
      spec({
        kind: "implementer",
        config: {
          launcher: { vcpus: 4 },
          container: { memory: { limit: "6g", reservation: "5g" } },
        },
      }),
    );
    await launch(
      build(),
      spec({
        kind: "implementer",
        jobId: "00000000-0000-4000-8000-000000000002",
        config: { container: { memory: { limit: "3000m" } } },
      }),
    );

    expect(service.creates.map((created) => created.vcpus)).toStrictEqual([
      4, 2,
    ]);
    expect(valuesOf(service.starts[0]?.args ?? [], "--memory")).toStrictEqual([
      "6g",
    ]);
    // The limit alone: the default reservation stays, and the swap follows the limit.
    expect(valuesOf(service.starts[1]?.args ?? [], "--memory")).toStrictEqual([
      "3000m",
    ]);
    expect(
      valuesOf(service.starts[1]?.args ?? [], "--memory-swap"),
    ).toStrictEqual(["3000m"]);
    expect(
      valuesOf(service.starts[1]?.args ?? [], "--memory-reservation"),
    ).toStrictEqual(["512m"]);
  });

  // #760-T04
  it.each<[string, LaunchSpec["config"]]>([
    [
      "a container memory the VM cannot give",
      { container: { memory: { limit: "4g", reservation: "3g" } } },
    ],
    [
      "a container memory above a larger VM's",
      { launcher: { vcpus: 4 }, container: { memory: { limit: "8g" } } },
    ],
    ["a VM size the platform does not have", { launcher: { vcpus: 3 } }],
    ["an option it does not know", { launcher: { disk: 128 } }],
    [
      "a reservation above the limit",
      { container: { memory: { limit: "1g", reservation: "3g" } } },
    ],
  ])(
    "refuses %s for an implementer job before it creates anything",
    async (_what, config) => {
      const error = failure(
        await launch(build(), spec({ kind: "implementer", config })),
      );

      expect(error.code).toBe("sandbox_config_invalid");
      expect(error.retryable).toBe(false);
      expect(service.creates).toStrictEqual([]);
      expect(() => validateKindConfig("implementer", config)).toThrow(
        LaunchError,
      );
    },
  );

  // #760-T04
  it("accepts the default configuration of the implementer kind", () => {
    expect(() => validateKindConfig("implementer", {})).not.toThrow();
    expect(planForKind("implementer", {})).toMatchObject({
      vcpus: 2,
      overrides: { memory: { limit: "768m", reservation: "512m" } },
      agentMemoryMb: 2304,
    });
    expect(SANDBOX_KIND_DEFAULTS.implementer).toStrictEqual({
      vcpus: 2,
      memory: { limit: "768m", reservation: "512m" },
    });
  });

  // #745 step 4: what is left of the VM for the agent's container, at each size the platform has. Every limit is counted in
  // full, the reader's too: OS and daemons 512, Control 768, the door 256, the reader 256 (1792 MB), 2048 MB per vCPU.
  it.each<[number, number]>([
    [1, 256],
    [2, 2304],
    [4, 6400],
    [6, 10496],
    [8, 14592],
  ])(
    "leaves the agent's container %i vCPU: %i MB after the OS, Control, the door and the reader",
    (vcpus, megabytes) => {
      expect(
        planForKind("implementer", { launcher: { vcpus } }).agentMemoryMb,
      ).toBe(megabytes);
      expect(agentMemoryMb(vcpus, 768)).toBe(megabytes);
    },
  );

  // #745 step 4: the limits of a VM add up to the VM, at every size
  it.each([2, 4, 6, 8])(
    "has the limits of all its containers and the OS add up to no more than the VM at %i vCPU",
    (vcpus) => {
      const plan = planForKind("implementer", { launcher: { vcpus } });
      expect(
        IMPLEMENTER_VM_HEADROOM_MB +
          768 +
          MODEL_DOOR_MEMORY_MB +
          READER_MEMORY_MB +
          plan.agentMemoryMb,
      ).toBe(vcpus * SANDBOX_MEMORY_PER_VCPU_MB);
    },
  );

  // #745 step 4: a Control container that would not fit beside the door and the reader is refused at start
  it("refuses a Control container that leaves no room for the door and the reader", () => {
    expect(() =>
      validateKindConfig("implementer", {
        launcher: { vcpus: 1 },
        container: { memory: { limit: "1100m", reservation: "512m" } },
      }),
    ).toThrow();
  });

  // #745 step 4: reviews are never given the names of the sandbox.
  it("hands the snapshot's Sysbox verdict to an implementer job and to no other kind", async () => {
    await launch(
      build({ sysboxProof: "proven" }),
      spec({ kind: "implementer" }),
    );
    expect(valuesOf(dockerRun()?.args ?? [], "--env")).toContain(
      "RUNNER_IMPLEMENTER_SANDBOX_PROOF=proven",
    );
  });

  // #745-T02: no verdict is no proof
  it("passes the verdict as it is, and a launch that was given none as unproven", async () => {
    expect(
      implementerEnvironment(planForKind("implementer", {}), "unproven"),
    ).toStrictEqual({
      RUNNER_IMPLEMENTER_SANDBOX_PROOF: "unproven",
      RUNNER_IMPLEMENTER_AGENT_MEMORY_MB: "2304",
    });
    await launch(build({}), spec({ kind: "implementer" }));
    expect(valuesOf(dockerRun()?.args ?? [], "--env")).toContain(
      "RUNNER_IMPLEMENTER_SANDBOX_PROOF=unproven",
    );
  });

  describe("the Sysbox boot of the Implementer's VM", () => {
    it("runs sysbox-prepare.sh as root after vm-prepare.sh and the image check, from the golden snapshot", async () => {
      await launch(build(), spec({ kind: "implementer" }));

      const labels = service.execs.map((call) => call.label);
      expect(labels.indexOf("sysbox-prepare")).toBeGreaterThan(
        labels.indexOf("image-id"),
      );
      expect(
        service.execs.find((call) => call.label === "sysbox-prepare"),
      ).toMatchObject({
        cmd: "/usr/local/sbin/sysbox-prepare.sh",
        args: [],
        sudo: true,
        timeoutMs: 40_000,
      });
    });

    // The point of the placement: a review's VM keeps its cgroup layout, its /proc and /dev as they were.
    it("never runs it for a Diff or a Dynamic job", async () => {
      await launch(build(), spec({ kind: "diff" }));
      await launch(
        build(),
        spec({
          kind: "dynamic",
          jobId: "00000000-0000-4000-8000-000000000002",
        }),
      );

      expect(
        service.execs.filter((call) => call.label === "sysbox-prepare"),
      ).toStrictEqual([]);
      expect(service.execs.map((call) => call.cmd)).not.toContain(
        "/usr/local/sbin/sysbox-prepare.sh",
      );
    });

    it("fails the launch with the stable code sysbox_not_ready, stops the VM and runs no container when the boot fails", async () => {
      service.onExec("sysbox-prepare", {
        exitCode: 24,
        stderr: `sysbox-prepare: sysbox_mgr_not_ready sysbox-mgr crashed\ncrj_${"A".repeat(43)}\n`,
      });

      const error = failure(
        await launch(build(), spec({ kind: "implementer" })),
      );

      expect(error.code).toBe("sysbox_not_ready");
      expect(error.retryable).toBe(true);
      expect(service.stops).toStrictEqual([service.creates[0]?.name]);
      expect(service.starts).toHaveLength(0);
      expect(service.running()).toStrictEqual([]);
      // The work volume is not made on a VM that cannot run its agent.
      expect(service.execs.map((call) => call.label)).not.toContain(
        "work-volume-dir",
      );
    });

    it("logs the name the boot script gave its failure, its exit status and a redacted tail", async () => {
      service.onExec("sysbox-prepare", {
        exitCode: 22,
        stderr: `sysbox-prepare: sysbox_proc_unmount_failed /proc/keys\ncrj_${"A".repeat(43)}\n`,
      });

      await launch(build(), spec({ kind: "implementer" }));

      const line = logger.lines.find((entry) =>
        entry.startsWith("warn sysbox_prepare_failed "),
      );
      expect(line).toBeDefined();
      expect(line).toContain('"code":"sysbox_not_ready"');
      expect(line).toContain('"exitCode":22');
      expect(line).toContain(`"jobId":"${JOB_ID}"`);
      expect(line).toContain("sysbox_proc_unmount_failed /proc/keys");
      expect(line).toContain("[redacted]");
      expect(line).not.toContain("crj_AAAA");
    });
  });

  // #760-T05
  it("stops the VM when a step of the work volume fails, and runs no container: the volume goes with the VM", async () => {
    service.onExec("work-volume-create", {
      exitCode: 1,
      stderr: "volume create refused",
    });

    const error = failure(await launch(build(), spec({ kind: "implementer" })));

    expect(error.code).toBe("work_volume_failed");
    expect(error.retryable).toBe(true);
    const name = service.creates[0]?.name;
    expect(service.stops).toStrictEqual([name]);
    expect(service.running()).toStrictEqual([]);
    expect(service.starts).toHaveLength(0);
    expect(service.execs.map((call) => call.label)).toStrictEqual([
      "run-directories",
      "run-directory-docker",
      "run-directory-containerd",
      "vm-prepare",
      "image-id",
      "sysbox-prepare",
      "work-volume-dir",
      "work-volume-reserve-image",
      "work-volume-reserve-fs",
      "work-volume-reserve-mount",
      "work-volume-mount",
      "work-volume-options",
      "work-volume-check",
      "work-volume-create",
    ]);
    // Nothing of the platform's text reaches the error or the log.
    expect(logger.text()).not.toContain("volume create refused");
  });

  // #760-T05
  it.each([
    "work-volume-dir",
    "work-volume-reserve-image",
    "work-volume-reserve-fs",
    "work-volume-reserve-mount",
    "work-volume-mount",
    "work-volume-options",
    "work-volume-check",
  ])("stops the VM and makes no later step when %s fails", async (label) => {
    service.onExec(label, { exitCode: 32 });

    const error = failure(await launch(build(), spec({ kind: "implementer" })));

    expect(error.code).toBe("work_volume_failed");
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
    expect(
      service.execs.some((call) => call.label === "work-volume-create"),
    ).toBe(false);
    expect(service.starts).toHaveLength(0);
  });

  // #760-T09: nothing checked the options before; a platform that ignores them would run the agent on a mount that honours setuid
  it.each([
    ["nosuid", "rw,nodev,relatime"],
    ["nodev", "rw,nosuid,relatime"],
    ["rw", "ro,nosuid,nodev,relatime"],
    ["no noexec", "rw,nosuid,nodev,noexec,relatime"],
  ])(
    "fails the launch with work_volume_failed when the mount lacks %s, before the volume is made",
    async (_what, options) => {
      service.onExec("work-volume-check", (call) => {
        const directory = service.execs.find(
          (other) => other.label === "work-volume-dir" && other.vm === call.vm,
        )?.args[2];
        return {
          stdout: `22 1 8:1 / / rw shared:1 - ext4 /dev/sda1 rw\n101 22 8:1 ${directory} ${directory} ${options} shared:1 - ext4 /dev/sda1 rw\n`,
        };
      });

      const error = failure(
        await launch(build(), spec({ kind: "implementer" })),
      );

      expect(error.code).toBe("work_volume_failed");
      expect(error.retryable).toBe(true);
      expect(service.stops).toStrictEqual([service.creates[0]?.name]);
      expect(
        service.execs.some((call) => call.label === "work-volume-create"),
      ).toBe(false);
      expect(service.starts).toHaveLength(0);
      // The log names the step, never the mountinfo.
      expect(logger.text()).toContain('"step":"work-volume-check"');
      expect(logger.text()).not.toContain("/dev/sda1");
    },
  );

  // #760-T09
  it("fails the launch when the mountinfo cannot be read", async () => {
    service.onExec("work-volume-check", { exitCode: 1, stderr: "cat: no" });

    const error = failure(await launch(build(), spec({ kind: "implementer" })));

    expect(error.code).toBe("work_volume_failed");
    expect(service.starts).toHaveLength(0);
  });

  // #760-T10: the constant 10 s was never exercised; a hung step has to end the launch, not wait for the VM's timeout
  it("ends a hung step of the work volume after 10 seconds, not before, with work_volume_failed and the VM stopped", async () => {
    service.hangOn("work-volume-mount");
    const launcher = build();
    const ended = launcher
      .launch(spec({ kind: "implementer" }), new AbortController().signal)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await settle();

    await clock.advance(9_999);
    expect(service.stops).toStrictEqual([]);
    await clock.advance(1);
    const error = (await ended) as LaunchError;

    expect(error).toBeInstanceOf(LaunchError);
    expect(error.code).toBe("work_volume_failed");
    expect(error.retryable).toBe(true);
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
    expect(service.starts).toHaveLength(0);
    expect(logger.text()).toContain('"step":"work-volume-mount"');
  });

  // #760-T10
  it("gives every step of the work volume its own 10 seconds and passes the same limit to the platform", async () => {
    await launch(build(), spec({ kind: "implementer" }));

    const steps = service.execs.filter((call) =>
      call.label.startsWith("work-volume"),
    );
    expect(steps).toHaveLength(8);
    for (const call of steps) expect(call.timeoutMs).toBe(10_000);
  });

  // #760-T10: the steps are part of the implementer's launch, which the VM's own timeout has to cover
  it("lets an implementer VM live as long as its job, the margin, the Sysbox boot and the steps of the work volume; Diff and Dynamic are unchanged", async () => {
    const reported: Array<{ timeoutSeconds: number }> = [];
    await launch(
      build(),
      spec({
        kind: "implementer",
        timeoutSeconds: 3600,
        onVmCreated: (vm) => reported.push(vm),
      }),
    );
    await launch(
      build(),
      spec({
        kind: "diff",
        jobId: "00000000-0000-4000-8000-000000000002",
        onVmCreated: (vm) => reported.push(vm),
      }),
    );

    expect(WORK_VOLUME_STEPS_SECONDS).toBe(80);
    expect(SYSBOX_PREPARE_SECONDS).toBe(40);
    expect(RUN_DIRECTORY_STEPS_SECONDS).toBe(9);
    expect(IMPLEMENTER_LAUNCH_EXTRA_SECONDS).toBe(129);
    const [implementer, diff] = service.creates;
    expect(implementer?.timeoutMs).toBe(
      (3600 + VM_TIMEOUT_MARGIN_SECONDS + IMPLEMENTER_LAUNCH_EXTRA_SECONDS) *
        1000,
    );
    expect(diff?.timeoutMs).toBe((1200 + VM_TIMEOUT_MARGIN_SECONDS) * 1000);
    expect(reported.map((vm) => vm.timeoutSeconds)).toStrictEqual([
      3600 + VM_TIMEOUT_MARGIN_SECONDS + IMPLEMENTER_LAUNCH_EXTRA_SECONDS,
      1200 + VM_TIMEOUT_MARGIN_SECONDS,
    ]);
  });

  // #760-T05
  it("stops the VM, and with it the volume, when the Worker ends early after the volume was made", async () => {
    const launcher = build();
    const ended = launcher
      .launch(spec({ kind: "implementer" }), new AbortController().signal)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await settle();

    service.exitProcess(service.creates[0]?.name ?? "", 2);
    const error = (await ended) as LaunchError;

    expect(error.code).toBe("worker_exited_early");
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
    // The one volume was created in the VM that was stopped; no step removes or re-creates one anywhere else.
    expect(
      service.execs.filter((call) => call.args.includes("create")),
    ).toHaveLength(1);
    expect(
      service.execs.every((call) => call.vm === service.creates[0]?.name),
    ).toBe(true);
    expect(service.running()).toStrictEqual([]);
  });

  // #760-T05
  it("aborts a launch during the work volume steps with launch_aborted and stops the VM", async () => {
    const stop = new AbortController();
    service.onExec("work-volume-mount", () => {
      stop.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const error = failure(
      await launch(build(), spec({ kind: "implementer" }), stop.signal),
    );

    expect(error.code).toBe("launch_aborted");
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
    expect(service.starts).toHaveLength(0);
  });

  // #765: advertised only by a deployment that serves the kind, because an advertised engine is required of every deploy
  it("advertises the implementer engine only when the deployment serves the kind: an advertised engine is required of the deploy canary", async () => {
    const signal = new AbortController().signal;

    expect(await build().capabilities(signal)).not.toContain("implementer");
    expect(
      await build({ servesImplementer: true }).capabilities(signal),
    ).toStrictEqual(["pr-agent", "opencode", "implementer"]);
  });

  // #329 (additional): the Launcher and the golden snapshot pipeline (#330) name the same things
  it("agrees with the golden snapshot pipeline on the script, the image tag and the region", () => {
    expect(VM_PREPARE_PATH).toBe(PATHS.vmPrepareInstalled);
    expect(SANDBOX_IMAGE_REFERENCE).toBe(DEFAULT_CONFIG.imageTag);
    expect(SANDBOX_REGION).toBe(DEFAULT_CONFIG.region);
  });

  // #329 (additional): the container is the shared hardened spec
  it("renders the container from the shared hardened spec", async () => {
    await launch(build());

    const args = dockerRun()?.args ?? [];
    expect(valuesOf(args, "--user")).toStrictEqual([
      WORKER_CONTAINER_SPEC.user,
    ]);
    expect(valuesOf(args, "--pids-limit")).toStrictEqual(["512"]);
    for (const forbidden of ["--privileged", "--volume", "-v", "--device"])
      expect(args).not.toContain(forbidden);
  });
});

describe("findings of the review of #354", () => {
  // #329-R02
  it("stops the VM by the name the platform returned, not the one it was asked for", async () => {
    service.renameCreatedVms((name) => `${name}-normalised`);
    service.onExec("image-id", { stdout: `${OTHER_IMAGE_ID}\n` });

    const error = failure(await launch(build()));

    const requested = service.creates[0]?.name ?? "";
    const returned = `${requested}-normalised`;
    expect(error.code).toBe("image_mismatch");
    expect(service.stops).toStrictEqual([returned]);
    expect(service.running()).toStrictEqual([]);
    expect(logger.text()).toContain("sandbox_name_mismatch");
  });

  // #329-R02
  it("stops a failed launch by the returned name too", async () => {
    service.renameCreatedVms((name) => `${name}-normalised`);
    service.onExec("image-id", { stdout: `${OTHER_IMAGE_ID}\n` });

    await launch(build());

    expect(service.stops).toStrictEqual([
      `${service.creates[0]?.name}-normalised`,
    ]);
    expect(service.running()).toStrictEqual([]);
  });

  // #329-R03
  it("gives the VM a timeout that covers the launch phase: the job plus 300 seconds by default", async () => {
    await launch(build());

    expect(service.creates[0]?.timeoutMs).toBe((1200 + 300) * 1000);
  });

  // #329-R03
  it("takes the margin from configuration", async () => {
    await launch(build({ vmTimeoutMarginSeconds: 600 }));

    expect(service.creates[0]?.timeoutMs).toBe((1200 + 600) * 1000);
  });

  // #329-R03
  it("refuses a margin below the floor that covers create, prepare, the image check and the hand-over", () => {
    expect(minimumVmTimeoutMargin(20)).toBe(180);
    expect(minimumVmTimeoutMargin(60)).toBe(210);

    expect(() => build({ vmTimeoutMarginSeconds: 179 })).toThrowError(
      /vmTimeoutMarginSeconds/,
    );
    expect(() =>
      build({ handoverSeconds: 60, vmTimeoutMarginSeconds: 209 }),
    ).toThrowError(/vmTimeoutMarginSeconds/);
    expect(() => build({ vmTimeoutMarginSeconds: 180 })).not.toThrow();
  });

  // #329-R04
  it("passes the mapped code through when a call of the host preparation fails at the platform", async () => {
    service.onExec("vm-prepare", () => {
      throw new SandboxServiceError("rate_limited");
    });

    const error = failure(await launch(build()));

    expect(error.code).toBe("sandbox_rate_limited");
    expect(error.retryable).toBe(true);
    expect(service.stops).toStrictEqual([service.creates[0]?.name]);
  });

  // #329-R04
  it("gives an unknown failure of the host preparation its own code", async () => {
    service.onExec("vm-prepare", () => {
      throw new Error("something odd 31337");
    });

    const error = failure(await launch(build()));

    expect(error.code).toBe("vm_prepare_failed");
    expect(error.retryable).toBe(true);
    expect(logger.text()).not.toContain("31337");
  });

  // #329-R04
  it.each<[number, boolean]>([
    // The Worker ran and said the job failed: it delivered its own result, and a second VM would do the same.
    [1, false],
    // A setup error of the Worker (2), docker's own refusals (125 to 127) and a kill (137): something about this VM
    // or its start, which a fresh VM can get right.
    [2, true],
    [125, true],
    [126, true],
    [127, true],
    [137, true],
  ])(
    "decides whether an exit with %s before the hand-over is retryable",
    async (exitCode, retryable) => {
      const launcher = build();
      const ended = launcher.launch(spec(), new AbortController().signal).then(
        () => undefined,
        (error: unknown) => error,
      );
      await settle();

      service.exitProcess(service.creates[0]?.name ?? "", exitCode);
      const error = (await ended) as LaunchError;

      expect(error.code).toBe("worker_exited_early");
      expect(error.retryable).toBe(retryable);
    },
  );
});

describe("the Sandbox-Launcher in the Dispatcher core", () => {
  // #329-T12
  it("makes the core release the job with launch_failed and count the attempt when the platform refuses", async () => {
    const app = await startApp();
    try {
      const jobId = app.enqueue();
      service.failNextCreate(new SandboxServiceError("quota_exceeded"));
      const core = createDispatcherCore({
        settings: settingsFor(app.url, { engines: ["pr-agent"] }),
        launcher: build(),
        logger,
        clock,
      });

      const result = await core.handle({
        appId: "reviewer",
        jobId,
        reviewKind: "diff",
      });
      expect(result.outcome).toBe("started");
      if (result.outcome !== "started") return;
      let done = false;
      void result.background.then(() => {
        done = true;
      });
      for (let step = 0; step < 100 && !done; step += 1) {
        await clock.advance(10_000);
        await settle();
      }
      await result.background;

      await waitFor(
        () => app.requests().some((request) => request.route === "release"),
        "the release",
      );
      expect(
        app.requests().filter((request) => request.route === "release"),
      ).toStrictEqual([
        { method: "POST", route: "release", jobId, status: 200 },
      ]);
      expect(logger.text()).toContain("launch_failed");
      expect(logger.text()).toContain("sandbox_quota_exceeded");
      expect(logger.text()).toContain('"retryable":true');
      expect(logger.text()).not.toContain(DISPATCHER_TOKEN);
    } finally {
      await app.close();
    }
  });

  // #487-T04
  it("lets the core's launch end at the hand-over and release nothing when the container ends with 2 afterwards", async () => {
    const app = await startApp();
    try {
      const jobId = app.enqueue();
      const core = createDispatcherCore({
        settings: settingsFor(app.url, { engines: ["pr-agent"] }),
        launcher: build(),
        logger,
        clock,
      });
      const started = core.handle({
        appId: "reviewer",
        jobId,
        reviewKind: "diff",
      });
      // The claim goes over real HTTP: the container is started when the App has answered, not after a fixed wait.
      await waitFor(() => dockerRun() !== undefined, "the container to start");
      await settle();
      await clock.advance(SANDBOX_HANDOVER_SECONDS * 1000);
      const result = await started;
      expect(result.outcome).toBe("started");
      if (result.outcome !== "started") return;
      // The launch resolves: nothing is left pending behind it.
      await result.background;
      expect(service.pendingWaits()).toBe(0);

      service.exitProcess(service.creates[0]?.name ?? "", 2);
      await settle();
      await clock.advance(60_000);

      expect(
        app.requests().filter((request) => request.route === "release"),
      ).toStrictEqual([]);
      expect(service.stops).toStrictEqual([]);
      expect(logger.text()).not.toContain("worker_exited");
      expect(logger.text()).not.toContain(DISPATCHER_TOKEN);
      expect(logger.text()).not.toContain(CREDENTIAL);
    } finally {
      await app.close();
    }
  });
});
